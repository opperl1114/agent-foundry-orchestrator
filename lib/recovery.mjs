// recovery.mjs - PHASE 4 RecoveryPlanner (Durable Recovery & Operator Control)
//
// Control Plane ONLY. Reads durable state (tasks/*.json + locks/) and classifies
// what happened after an orchestrator/WSL/process crash, then either reports a
// recommended action or executes an explicitly allowed recovery.
//
// Hard boundaries:
//   - tasks/<task_id>.json is the ONLY lifecycle truth. runtime/scheduler.json
//     is metadata. No second registry is built here.
//   - Governance truth (candidate / formal review / policy / Human Gate /
//     publish) stays in vault-mcp. Recovery may only QUERY it via the existing
//     GovernanceBridge and map the verdict - never re-implement or guess it.
//   - A crash is NEVER papered over: interrupted runs are recorded as
//     INTERRUPTED / UNKNOWN_OUTCOME, never as FAILED or PASS.
//   - Recovery is idempotent: every side-effecting step re-checks the durable
//     evidence (runs[], acceptance_runs[], governance mirror, state_version)
//     before it acts.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskFile, taskFileExists, saveTaskAtomic } from './store.mjs';
import { readLock, isLockStale } from './tasklock.mjs';

export const RECOVERY_CLASSES = Object.freeze([
  'TERMINAL', 'WAITING_EXTERNAL', 'RESUMABLE', 'INTERRUPTED', 'UNSAFE_TO_AUTO_RESUME',
]);

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const RUNNING_LIKE_STATES = new Set(['AUTHOR_RUNNING', 'REVIEW_RUNNING', 'GOVERNANCE_PENDING', 'PUBLISHING']);

// ---- durable-evidence helpers -------------------------------------------------

// The author/fix output is "fully persisted" when the last author-purpose run
// completed AND its content was staged (last_author_content present).
export function authorResultPersisted(task) {
  const authorRuns = (task.runs ?? []).filter((r) => r.purpose === 'author' || r.purpose === 'fix');
  const last = authorRuns[authorRuns.length - 1] ?? null;
  return !!(last && last.status === 'completed' && typeof task.last_author_content === 'string'
    && task.last_author_content.length > 0);
}

// The latest QA review result is "fully persisted" when decision+binding exist.
export function reviewResultPersisted(task) {
  const r = task.last_review;
  return !!(r && r.decision && Array.isArray(r.required_changes ?? []) && r.reviewed_executor_run_id);
}

// An acceptance result is "authoritative" when a finished record with a real
// exit code exists (reused on recovery instead of re-running the command).
export function latestAuthoritativeAcceptance(task) {
  const runs = task.acceptance_runs ?? [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const a = runs[i];
    if (typeof a.exit_code === 'number' && a.finished_at) return a;
  }
  return null;
}

// ---- classification ------------------------------------------------------------

export function classifyRecovery(task, { lockHeld = false, availability = null } = {}) {
  const state = task.state;
  const base = {
    task_id: task.task_id,
    state,
    revision: task.revisions_used ?? 1,
    state_version: task.state_version ?? 0,
    author_session_ref: task.author_session_ref ?? null,
    author_session_executor_type: task.author_session_executor_type ?? null,
    candidate_id: task.governance?.candidate_id ?? null,
    latest_run: (task.runs ?? [])[(task.runs ?? []).length - 1] ?? null,
    last_error: task.failure_reason ?? null,
  };

  if (TERMINAL_STATES.has(state)) {
    return { ...base, recovery_class: 'TERMINAL', recommended_action: 'none', recoverable: false };
  }

  if (state === 'WAITING_HUMAN') {
    return {
      ...base,
      recovery_class: 'WAITING_EXTERNAL',
      recommended_action: task.governance?.candidate_id
        ? 'wait for the real Human Gate, then: orchestrator recover --task-id <id> (re-queries vault truth by this candidate_id)'
        : 'UNSAFE: WAITING_HUMAN without candidate_id - manual inspection required',
      recoverable: !!task.governance?.candidate_id,
      human_gate_status: task.governance?.human_gate_status ?? null,
    };
  }

  // availability gate: an exact-resume recovery cannot proceed when the
  // original executor is currently UNAVAILABLE (e.g. agy ACCOUNT_DISABLED_403).
  // This is an availability fact, never a capability downgrade, and never a
  // reason to silently swap executors while pretending to resume context.
  const needsExactResume = state === 'NEEDS_FIX' || state === 'AUTHOR_RUNNING';
  const exactExecutor = task.author_session_executor_type;
  if (needsExactResume && exactExecutor && availability?.[exactExecutor]?.availability_status === 'UNAVAILABLE') {
    return {
      ...base,
      recovery_class: 'UNSAFE_TO_AUTO_RESUME',
      reason: `EXECUTOR_UNAVAILABLE_FOR_EXACT_RESUME: ${exactExecutor} availability=UNAVAILABLE (${availability[exactExecutor].reason ?? 'unknown'})`,
      recommended_action: `wait for ${exactExecutor} to become available, or manually decide a from-scratch re-run (new session, no fake resume)`,
      recoverable: false,
    };
  }

  if (state === 'NEEDS_FIX') {
    const ok = !!(task.author_session_ref && reviewResultPersisted(task));
    return {
      ...base,
      recovery_class: ok ? 'RESUMABLE' : 'UNSAFE_TO_AUTO_RESUME',
      reason: ok ? null : 'NEEDS_FIX without persisted author session or complete review feedback',
      recommended_action: ok
        ? 'exact resume the original author session with the persisted review feedback, then continue the loop'
        : 'manual inspection required (missing durable evidence)',
      recoverable: ok,
    };
  }

  if (state === 'AUTHOR_RUNNING') {
    if (authorResultPersisted(task)) {
      // author actually finished; the crash happened before/during review
      return {
        ...base,
        recovery_class: 'RESUMABLE',
        reason: 'author result fully persisted - only the reviewer needs to run',
        recommended_action: 'start a fresh independent reviewer run (author is NOT re-run), then continue the loop',
        recoverable: true,
      };
    }
    return {
      ...base,
      recovery_class: 'INTERRUPTED',
      reason: 'author run was in progress with no durable result - outcome UNKNOWN_OUTCOME',
      recommended_action: 'manual decision required: re-run the author from scratch (new session) or discard the task; nothing is auto-rerun',
      recoverable: false,
      interrupted_run: task.runs?.some((r) => r.execution_outcome === 'interrupted') ?? null,
    };
  }

  if (state === 'REVIEW_RUNNING') {
    if (authorResultPersisted(task)) {
      return {
        ...base,
        recovery_class: 'RESUMABLE',
        reason: 'author result fully persisted; the interrupted reviewer can be recreated independently',
        recommended_action: 'start a fresh independent reviewer run (author is NOT re-run), then continue the loop',
        recoverable: true,
      };
    }
    return {
      ...base,
      recovery_class: 'INTERRUPTED',
      reason: 'review was running but no durable author result exists',
      recommended_action: 'manual decision required',
      recoverable: false,
    };
  }

  if (state === 'GOVERNANCE_PENDING') {
    const hasCandidate = !!task.governance?.candidate_id;
    return {
      ...base,
      recovery_class: hasCandidate ? 'UNSAFE_TO_AUTO_RESUME' : 'UNSAFE_TO_AUTO_RESUME',
      reason: hasCandidate
        ? 'crash inside the governance stage - the vault truth for this candidate_id must be queried before anything is re-run'
        : 'crash before candidate creation - author content is durable, but governance must resume from the vault truth, never by blind re-run',
      recommended_action: hasCandidate
        ? `recover --task-id <id>: re-query vault truth for ${task.governance.candidate_id} (published? approval? stale?) and settle/resume accordingly`
        : 'recover --task-id <id>: author content is durable, so only the remaining governance steps run (candidate/formal review are re-checked for idempotency)',
      recoverable: true,
      governed_recovery: true,
    };
  }

  if (state === 'PUBLISHING') {
    if (!task.governance?.candidate_id) {
      return {
        ...base,
        recovery_class: 'UNSAFE_TO_AUTO_RESUME',
        reason: 'PUBLISHING without candidate_id - the publish outcome cannot be correlated',
        recommended_action: 'manual inspection required',
        recoverable: false,
      };
    }
    return {
      ...base,
      recovery_class: 'UNSAFE_TO_AUTO_RESUME',
      reason: 'crash during publish - the vault truth decides: published already (settle) vs approval missing (WAITING) vs stale (manual) vs safe to publish (continue)',
      recommended_action: `recover --task-id <id>: query vault truth for candidate ${task.governance.candidate_id}, then settle/resume - never blind re-publish`,
      recoverable: true,
      governed_recovery: true,
    };
  }

  return { ...base, recovery_class: 'UNSAFE_TO_AUTO_RESUME', reason: `unknown state ${state}`, recommended_action: 'manual inspection required', recoverable: false };
}

// ---- scan (read-only) ----------------------------------------------------------

export function scanRecovery(tasksDir, { locksDir = null, availability = null, lockHeldIds = null } = {}) {
  const out = [];
  if (!existsSync(tasksDir)) return out;
  for (const f of readdirSync(tasksDir)) {
    if (!f.endsWith('.json')) continue;
    let task;
    try { task = readTaskFile(join(tasksDir, f)); } catch {
      out.push({ file: f, recovery_class: 'UNSAFE_TO_AUTO_RESUME', reason: 'unreadable task file', recommended_action: 'manual inspection' });
      continue;
    }
    // task *definition* files (e.g. rh2.json, e2e-a.json) carry no lifecycle
    // state - they are inputs to run, not lifecycle truth; skip them.
    if (!task.state) continue;
    const held = lockHeldIds ? lockHeldIds.has(task.task_id) : false;
    let lockInfo = null;
    if (locksDir) {
      const lock = readLock(locksDir, task.task_id);
      lockInfo = lock ? { owner: lock.orchestrator_instance_id, pid: lock.pid, stale: isLockStale(lock) } : null;
      if (lock && !isLockStale(lock)) {
        // a live lock held by another owner is reflected in the classification
        lockHeldIds = lockHeldIds ?? new Set();
        lockHeldIds.add(task.task_id);
      }
    }
    const c = classifyRecovery(task, { lockHeld: lockHeldIds ? lockHeldIds.has(task.task_id) : false, availability });
    if (lockInfo) c.lock = lockInfo;
    out.push(c);
  }
  return out;
}

// STALE_RECOVERY_PLAN: raised when the durable state advanced (state_version)
// between planning a recovery and executing it - the old plan must never
// overwrite the newer state; the caller re-reads and re-plans.
export const STALE_RECOVERY_PLAN = 'STALE_RECOVERY_PLAN';

// Executes an explicitly operator-requested recovery for ONE task.
// - Acquires the task lock (TASK_ALREADY_RUNNING on a valid foreign lock;
//   stale locks are recovered and recorded).
// - Refuses terminal tasks (TASK_TERMINAL) - COMPLETED/FAILED/CANCELLED are
//   never re-run by recovery.
// - DISPATCHES to continueTask / resumeGovernance (injected to avoid a
//   circular import with orchestrator.mjs).
// - Guarded by state_version: if the durable state advanced between planning
//   and execution, the stale plan is aborted (STALE_RECOVERY_PLAN).
// - Idempotent: every continuation re-checks durable evidence before acting.
// - Records a minimal recovery attempt into task.recovery_attempts[].
export async function recoverTask(taskId, {
  tasksDir, locksDir,
  continueTaskFn, resumeGovernanceFn,
  adapters, governanceBridge = null, targetCoordination = null,
  availability = null, orchestratorInstanceId, planStateVersion = null,
  maxAttemptsRecord = 10,
} = {}) {
  const { acquireTaskLock, releaseTaskLock, readLock } = await import('./tasklock.mjs');
  const recovery_id = `RECOV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const started_at = new Date().toISOString();
  let lockInfo;
  try {
    lockInfo = acquireTaskLock(locksDir, taskId, { orchestratorInstanceId });
  } catch (err) {
    return {
      outcome: 'RECOVERY_ERROR',
      recovery_id,
      error: String(err?.message ?? err),
      code: err?.code ?? 'TASK_ALREADY_RUNNING',
      task: null,
      stale_lock_recovered: false,
    };
  }
  try {
    const task = readTaskFile(join(tasksDir, `${taskId}.json`));
    const classification = classifyRecovery(task, {
      lockHeld: true,
      availability: availability ?? null,
    });
    const attempt = {
      recovery_id, started_at, classification: classification.recovery_class,
      action: classification.recommended_action ?? null, finished_at: null, outcome: null,
    };
    task.recovery_attempts = task.recovery_attempts ?? [];
    task.recovery_attempts.push(attempt);
    if (task.recovery_attempts.length > maxAttemptsRecord) task.recovery_attempts.shift();
    saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);

    // state_version stale-plan guard (TEST I): the plan was made against
    // planStateVersion; if the durable state has advanced since, abort.
    if (planStateVersion !== null && Number(task.state_version ?? 0) !== Number(planStateVersion)) {
      attempt.finished_at = new Date().toISOString();
      attempt.outcome = STALE_RECOVERY_PLAN;
      saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);
      throw Object.assign(
        new Error(`${STALE_RECOVERY_PLAN}: planned against state_version=${planStateVersion}, durable state is ${task.state_version} - re-read and re-plan`),
        { code: STALE_RECOVERY_PLAN },
      );
    }

    let outcome;
    let finalTask;
    if (classification.recovery_class === 'TERMINAL') {
      outcome = { state: task.state, note: 'terminal state - recovery performs no side effects' };
      finalTask = task;
    } else if (classification.recovery_class === 'WAITING_EXTERNAL') {
      // WAITING_HUMAN: only this task's candidate_id is re-queried against
      // the vault truth (resumeGovernance enforces the correlation).
      finalTask = await resumeGovernanceFn(taskId, { adapters, bridgeOverride: governanceBridge });
      outcome = { state: finalTask.state };
    } else if (classification.recovery_class === 'RESUMABLE'
      || (classification.recovery_class === 'UNSAFE_TO_AUTO_RESUME' && classification.governed_recovery)
      || (classification.recovery_class === 'UNSAFE_TO_AUTO_RESUME' && classification.state === 'GOVERNANCE_PENDING')) {
      // RESUMABLE: continueTask picks the smallest safe continuation.
      // governed_recovery: crash inside governance - the continuation re-queries
      // vault truth (settleIfPublished / candidate reuse) and never blind-republishes.
      finalTask = await continueTaskFn(taskId, { adapters, governanceBridge, targetCoordination });
      outcome = { state: finalTask.state, failure_reason: finalTask.failure_reason ?? null };
    } else {
      // INTERRUPTED (no durable result) or genuinely unsafe: NOT auto-recovered.
      // For INTERRUPTED the unknown-outcome run is recorded explicitly - never
      // papered over as FAILED or PASS.
      if (classification.recovery_class === 'INTERRUPTED') {
        const purpose = task.state === 'REVIEW_RUNNING' ? 'reviewer' : 'author';
        task.runs = task.runs ?? [];
        if (!task.runs.some((r) => r.execution_outcome === 'interrupted')) {
          task.runs.push({
            executor_run_id: `RUN-INT-${Math.random().toString(36).slice(2, 8)}`,
            executor_type: task.author_session_executor_type ?? 'unknown',
            assigned_role: purpose,
            purpose,
            status: 'interrupted',
            execution_outcome: 'interrupted',
            session_ref: null,
            exit_code: null,
            started_at: null,
            finished_at: null,
            error: 'UNKNOWN_OUTCOME: orchestrator process died before this run finished',
          });
          task.updated_at = new Date().toISOString();
          saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);
        }
      }
      outcome = { state: task.state, note: classification.recommended_action ?? 'manual decision required' };
      finalTask = task;
    }
    attempt.finished_at = new Date().toISOString();
    attempt.outcome = outcome.state ?? JSON.stringify(outcome).slice(0, 120);
    finalTask = finalTask ?? task;
    finalTask.recovery_attempts = task.recovery_attempts;
    finalTask.updated_at = new Date().toISOString();
    saveTaskAtomic(join(tasksDir, `${taskId}.json`), finalTask);
    return {
      outcome: 'RECOVERED',
      recovery_id,
      classification: classification.recovery_class,
      state: finalTask.state,
      task: finalTask,
      stale_lock_recovered: lockInfo.stale_lock_recovered ?? false,
    };
  } catch (err) {
    // task-local failure: record and return the durable state (the operator
    // decides next steps); a CLI-level failure is never a fake success.
    let t = null;
    try { t = readTaskFile(join(tasksDir, `${taskId}.json`)); } catch { /* gone */ }
    return {
      outcome: 'RECOVERY_ERROR',
      recovery_id,
      error: String(err?.message ?? err),
      code: err?.code ?? null,
      state: t?.state ?? null,
      task: t,
      stale_lock_recovered: lockInfo.stale_lock_recovered ?? false,
    };
  } finally {
    releaseTaskLock(locksDir, taskId, lockInfo.lock);
  }
}
