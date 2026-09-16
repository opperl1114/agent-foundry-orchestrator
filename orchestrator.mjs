// orchestrator.mjs - Agent Foundry Orchestrator (PHASE 1.1 hardened)
//
// Scope freeze (fact baseline):
//   - One user input -> author run -> structured review -> NEEDS_FIX loop
//     (auto resume) -> re-review -> deterministic acceptance -> COMPLETED.
//     No human message relay anywhere in the loop.
//   - States: CREATED AUTHOR_RUNNING REVIEW_RUNNING NEEDS_FIX COMPLETED
//     FAILED CANCELLED. No POLICY_EVAL/WAITING_HUMAN/PUBLISHING.
//   - Task Lifecycle Truth: tasks/<task_id>.json, atomic writes only.
//   - ROLE != PLATFORM: roles come from the task file, never from a platform.
//   - Acceptance TRUST BOUNDARY: the acceptance command originates only from
//     the task definition; agent output can never become a command.
//   - Task QA review only; Vault formal review is NOT re-implemented here.
//
// Usage:
//   node orchestrator.mjs run --task-file <task.json>
//   node orchestrator.mjs status --task-id TASK-001
//   node orchestrator.mjs inspect --task-id TASK-001
//   node orchestrator.mjs cancel --task-id TASK-001

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectExecutor, ADAPTERS } from './lib/adapters.mjs';
import { classifyExecutionError } from './lib/executor-error-classifier.mjs';
import { readTaskFile, taskFileExists, saveTaskWithVersion } from './lib/store.mjs';
import { runAcceptance, normalizeAcceptanceCmd, acceptanceBinding } from './lib/acceptance.mjs';
import { GovernanceBridge, classifyPublishVerdict } from './lib/governance.mjs';
import { bindReviewResult, latestAuthorRun } from './lib/reviews.mjs';
import { readLock, isLockStale } from './lib/tasklock.mjs';
import { authorResultPersisted, reviewResultPersisted, latestAuthoritativeAcceptance } from './lib/recovery.mjs';
import { WorktreeSession, buildPlanBatches } from './lib/worktree.mjs';

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

// A cancellation is sticky: a later dispatch must never revive a cancelled task
// or overwrite its verdict. FAILED is excluded because the scheduler
// deliberately re-dispatches it to spend its bounded retry / fallback budget.
const NON_REVIVABLE_STATES = new Set(['CANCELLED']);

const ROOT = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = process.env.AF_TASKS_DIR || join(ROOT, 'tasks');
const LOCKS_DIR = join(ROOT, 'locks');
const MAX_REVISIONS_DEFAULT = 3;

const RUNNING_STATES = new Set(['AUTHOR_RUNNING', 'FIX_RUNNING', 'REVIEW_RUNNING']);

function taskPath(taskId) {
  return join(TASKS_DIR, `${taskId}.json`);
}

// A task object may carry a non-enumerable __tasksDir (set by continueTask /
// resumeGovernance when recovering from an injected tasks dir); default writes
// always go to the canonical TASKS_DIR.
function tasksDirOf(task) {
  return task?.__tasksDir ?? TASKS_DIR;
}

function saveTask(task) {
  // Phase 1.1: atomic write + monotonic state_version for update ordering.
  // Delegates to the single version-incrementing writer in lib/store.mjs.
  saveTaskWithVersion(tasksDirOf(task), task);
}

function loadTask(taskId, tasksDir = TASKS_DIR) {
  const p = join(tasksDir, `${taskId}.json`);
  if (!taskFileExists(p)) throw new Error(`task not found: ${taskId}`);
  return readTaskFile(p);
}

function withTasksDir(task, tasksDir) {
  if (tasksDir && tasksDir !== TASKS_DIR) {
    Object.defineProperty(task, '__tasksDir', { value: tasksDir, enumerable: false });
  }
  return task;
}

function recordRun(task, executorType, assignedRole, result, purpose) {
  // Phase 1.1 reviewer independence: a run id must never be reused, and a
  // review run must never collide with the author/fix session it reviews.
  if (task.runs.some((r) => r.executor_run_id === result.executor_run_id)) {
    throw new Error(`executor_run_id reused: ${result.executor_run_id}`);
  }
  task.runs.push({
    executor_run_id: result.executor_run_id,
    executor_type: executorType,
    assigned_role: assignedRole,
    purpose,                       // author | fix | review
    status: result.status,
    session_ref: result.session_ref,
    exit_code: result.exit_code,
    started_at: result.started_at,
    finished_at: result.finished_at,
    error: result.error,
  });
}

function capsuleForAuthor(task, revision) {
  const parts = [
    `You are acting as the ${task.author_role} in a task workflow (executor identity does not determine your role).`,
    `TASK_ID: ${task.task_id}`,
    `REVISION: ${revision}`,
    `GOAL: ${task.goal}`,
    `ACCEPTANCE: ${task.acceptance}`,
    `RED_LINES: ${task.red_lines.join('; ')}`,
    `Working directory: ${task.fixture_dir}`,
    `Do the work in that directory. Keep changes minimal and runnable.`,
    `When done, reply with a short summary of what you changed.`,
  ];
  if (task.task_mode === 'governed_write') {
    const c = task.candidate ?? {};
    parts.push(
      `GOVERNED WRITE: the text between <PAGE> and </PAGE> markers in your reply will be submitted VERBATIM as a formal candidate for publication to target: ${c.target ?? 'n/a'}.`,
      `Format rules: wrap ONLY the final page between <PAGE> and </PAGE>; the page body must NOT include YAML frontmatter, title headings, status notes, or any process narration (publish metadata like tags/summary is passed separately by the orchestrator).`,
      `Anything outside the markers is treated as process narration and discarded.`,
      `IMPORTANT: do NOT create candidate files yourself and do NOT write into any 收件箱/写回候选 directory - the orchestrator submits the candidate through vault-mcp on your behalf. Your job is only the <PAGE> reply.`,
    );
  }
  if (revision > 1 && task.last_review) {
    parts.push(`REVIEW_FEEDBACK (from reviewer, address every required change):`);
    for (const [i, rc] of (task.last_review.required_changes ?? []).entries()) {
      parts.push(`  ${i + 1}. ${rc}`);
    }
    if (task.last_review.issues?.length) {
      parts.push(`ISSUES: ${task.last_review.issues.join('; ')}`);
    }
  }
  if (revision > 1 && task.last_acceptance_failure) {
    const f = task.last_acceptance_failure;
    parts.push(`ACCEPTANCE_FAILURE (deterministic verification failed; fix the code so this command passes):`);
    parts.push(`  command: ${f.command} ${JSON.stringify(f.args ?? '')}`);
    parts.push(`  exit_code: ${f.exit_code}`);
    parts.push(`  stdout: ${f.stdout_summary}`);
    parts.push(`  stderr: ${f.stderr_summary}`);
    parts.push(`  failure_reason: ${f.failure_reason}`);
  }
  return {
    prompt: parts.join('\n'),
    task_id: task.task_id,
    runId: task.next_run_id ?? null,
    assigned_role: task.author_role,
    cwd: task.fixture_dir,
    acceptEdits: true,
    model: task.author_model || task.model,
    effort: task.author_effort || task.effort,
    timeout_ms: task.timeout_ms ?? 600000,
    protect_active_process: task.protect_active_process !== false,
    idle_timeout_ms: task.idle_timeout_ms ?? 900000,
  };
}

function capsuleForReview(task, revision) {
  const reviewSchema = {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['PASS', 'NEEDS_FIX'] },
      // PHASE 3 anti-cross-talk echo: reviewer repeats task_id/revision so a
      // stale/misrouted result is detectable (optional for legacy reviewers).
      task_id: { type: 'string' },
      revision: { type: 'number' },
      summary: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
      required_changes: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'string' } },
    },
    required: ['decision', 'summary', 'issues', 'required_changes', 'evidence'],
    additionalProperties: false,
  };
  const parts = [
    `You are acting as the reviewer in a task workflow. Your review must be independent and evidence-based.`,
    `TASK_ID: ${task.task_id}`,
    `REVISION UNDER REVIEW: ${revision}`,
    `ORIGINAL GOAL: ${task.goal}`,
    `ACCEPTANCE: ${task.acceptance}`,
    `REVIEW_SCOPE_RULES: ${task.review_rules.join('; ')}`,
    ...(task.task_mode === 'governed_write'
      ? [`The author's submission is at ${join(task.fixture_dir, 'orchestrator-submission.md')} - review THAT file (it is the exact content that would be published).`]
      : [`Working directory: ${task.fixture_dir} - inspect the files yourself. Cite file:line evidence.`]),
    `Respond with ONLY a JSON object of exactly this shape (no markdown fences, no extra text):`,
    JSON.stringify({ decision: 'PASS | NEEDS_FIX', summary: 'one paragraph', issues: ['...'], required_changes: ['...'], evidence: ['file:line or command output'] }),
    `Include "task_id" and "revision" in the JSON, echoing the TASK_ID and REVISION UNDER REVIEW above exactly (anti cross-talk binding).`,
    `decision must be PASS only if every REVIEW_SCOPE_RULES item holds; otherwise NEEDS_FIX with concrete required_changes.`,
  ];
  return {
    prompt: parts.join('\n'),
    task_id: task.task_id,
    runId: task.next_run_id ?? null,
    assigned_role: task.reviewer_role,
    cwd: task.fixture_dir,
    response_schema: reviewSchema,
    model: task.reviewer_model || task.model,
    effort: task.reviewer_effort || task.effort || (task.reviewer_executor === 'cline' ? 'xhigh' : undefined),
    timeout_ms: task.timeout_ms ?? 600000,
    protect_active_process: task.protect_active_process !== false,
    idle_timeout_ms: task.idle_timeout_ms ?? 900000,
    cline_fallback_model: task.cline_fallback_model || 'cline-pass/deepseek-v4-flash',
    cline_fallback_effort: task.cline_fallback_effort || 'xhigh',
  };
}

function parseReviewerResult(executorType, structured) {
  // agy: schema-constrained structured_output; claude: text inside the json
  // envelope - JSON.parse it. Never string-matching on "PASS".
  const raw = executorType === 'antigravity'
    ? structured?.parsed
    : extractJson(structured?.result ?? '');
  if (!raw || !raw.decision) return { ok: false, review: null, raw: null };
  if (raw.decision !== 'PASS' && raw.decision !== 'NEEDS_FIX') return { ok: false, review: raw, raw };
  return {
    ok: true,
    review: {
      decision: raw.decision,
      summary: raw.summary ?? '',
      issues: raw.issues ?? [],
      required_changes: raw.required_changes ?? [],
      evidence: raw.evidence ?? [],
    },
    raw,
  };
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function runAuthor(task, revision, adapters, opts = {}) {
  let adapter = selectExecutor(task.author_executor, { requiresMcp: !!task.requires_mcp, adapters });
  const runId = `RUN-${randomUUID().slice(0, 8)}`;
  task.next_run_id = runId;
  opts.onRunStart?.(runId, adapter.type);
  const purpose = revision === 1 ? 'author' : 'fix';
  if (purpose === 'fix' && adapter.type !== task.author_session_executor_type) {
    // fix must resume the ORIGINAL author session -> same executor type.
    adapter = adapters[task.author_session_executor_type];
  }
  const capsule = capsuleForAuthor(task, revision);
  const result = purpose === 'fix'
    ? await adapter.resume(task.author_session_ref, capsule)
    : await adapter.run(capsule);
  result.executor_run_id = runId; // stable identity for precise cancellation
  recordRun(task, adapter.type, capsule.assigned_role, result, purpose);
  if (result.status === 'cancelled') {
    const err = new Error('author run cancelled by operator');
    err.code = 'RUN_CANCELLED';
    throw err;
  }
  if (result.status !== 'completed') {
    const classification = result.error_classification || classifyExecutionError(adapter.type, { exit_code: result.exit_code ?? 1, stderr: result.error || 'run failed' });
    task.error_classification = classification;
    task.retryable = classification.retryable;
    const err = new Error(`author run failed: ${result.error}`);
    err.error_classification = classification;
    throw err;
  }
  task.last_author_content = result.structured_result?.result ?? null;
  // Record WHICH revision produced the staged content. Without it a crash
  // during a fix left the previous revision's content looking like a durable
  // result for the new revision, so recovery skipped the fix and reviewed stale
  // content.
  task.author_content_revision = revision;
  if (purpose === 'author') {
    task.author_session_ref = result.session_ref;
    task.author_session_executor_type = adapter.type;
  }
  return result;
}

async function runReview(task, revision, adapters, opts = {}) {
  const adapter = selectExecutor(task.reviewer_executor, { requiresMcp: !!task.requires_mcp, adapters });
  const runId = `RUN-${randomUUID().slice(0, 8)}`;
  task.next_run_id = runId;
  opts.onRunStart?.(runId, adapter.type);
  const capsule = capsuleForReview(task, revision);
  let result = await adapter.run(capsule);
  result.executor_run_id = runId;
  recordRun(task, adapter.type, capsule.assigned_role, result, 'review');
  if (result.status === 'cancelled') {
    const err = new Error('review run cancelled by operator');
    err.code = 'RUN_CANCELLED';
    throw err;
  }
  // Phase 1.1 independence: a reviewer on the same platform must still use a
  // different session than the author/fix session it reviews. Different
  // executor types are naturally independent; same type is checked strictly.
  if (adapter.type === task.author_session_executor_type
      && result.session_ref
      && result.session_ref === task.author_session_ref) {
    throw new Error('reviewer session collides with author session (independence violation)');
  }
  let { ok, review, raw } = parseReviewerResult(adapter.type, result.structured_result);
  if (!ok && result.status === 'completed') {
    // one structured-output retry before failing the review leg
    result = await adapter.run(capsule);
    recordRun(task, adapter.type, capsule.assigned_role, result, 'review');
    ({ ok, review, raw } = parseReviewerResult(adapter.type, result.structured_result));
  }
  if (result.status !== 'completed' || !ok) {
    const classification = result.error_classification || classifyExecutionError(adapter.type, { exit_code: result.exit_code ?? 1, stderr: result.error || 'no decision JSON' });
    task.error_classification = classification;
    task.retryable = classification.retryable;
    const err = new Error(`review run failed or unparseable: ${result.error ?? 'no decision JSON'}`);
    err.error_classification = classification;
    throw err;
  }
  // PHASE 3 anti-cross-talk: bind this reviewer result to THIS task, the
  // current revision and the exact author/fix run under review. A result that
  // carries a disagreeing task_id/revision echo (e.g. TASK-A's review routed
  // at TASK-B) is rejected here and never enters the fix loop.
  review = bindReviewResult(task, revision, latestAuthorRun(task), review, {
    task_id: raw?.task_id ?? null,
    revision: raw?.revision ?? null,
  });
  task.last_review = review;
  return review;
}

// Executes the task-defined acceptance command (trusted source only - see
// lib/acceptance.mjs). Agent output is never consulted for commands.
// An acceptance result is reused on recovery only for the EXACT author content
// it validated (content-addressed reuse). Comparing the revision alone was not
// enough: a bounded retry or an executor fallback re-runs the author WITHOUT
// bumping the revision, so a stale record could mark fresh content as verified.
// Records written before this binding existed carry no content_sha256 and are
// therefore never reused (conservative migration for historical tasks).
function authorContentSha(task) {
  const content = typeof task.last_author_content === 'string' ? task.last_author_content : '';
  return createHash('sha256').update(content).digest('hex');
}

async function acceptanceGate(task, revision) {
  const prev = latestAuthoritativeAcceptance(task);
  const currentSha = authorContentSha(task);
  if (prev && prev.content_sha256 && prev.content_sha256 === currentSha) {
    return {
      ok: prev.exit_code === 0,
      output: prev.stdout_summary,
      reused: true,
      record: prev,
    };
  }
  const acc = await runAcceptance(task);
  if (acc.record) {
    acc.record.revision = revision;
    acc.record.author_run_id = latestAuthorRun(task)?.executor_run_id ?? null;
    acc.record.content_sha256 = currentSha;
    task.acceptance_runs = task.acceptance_runs ?? [];
    task.acceptance_runs.push(acc.record);
  }
  return acc;
}

// ---------------------------------------------------------------- Phase 2
// Governance Bridge flow (governed_write tasks). Coordination only:
// candidate creation, formal review evidence and the publish verdict are all
// produced by vault-mcp; this function copies verdicts into the observed
// mirror (governance_source = "vault-mcp") and maps them to Control Plane
// states. Agent-reported policy decisions are recorded as correlation data
// and NEVER trusted as the verdict.
function governanceMirror(task) {
  task.governance = task.governance ?? { governance_source: 'vault-mcp' };
  return task.governance;
}

// governed_write: the author's <PAGE> reply is staged into the workspace so
// the QA reviewer can read the exact bytes that would be published.
function stageSubmission(task) {
  const page = extractPageContent(task.last_author_content ?? '');
  if (!page) return;
  const p = join(task.fixture_dir, 'orchestrator-submission.md');
  writeFileSync(p, page);
  task.submission_path = p;
}

function extractPageContent(text) {
  const m = (text ?? '').match(/<PAGE>\s*([\s\S]*?)\s*<\/PAGE>/);
  return m ? m[1] : null;
}

function lastAuthorContent(task) {
  if (task.last_author_content) return task.last_author_content;
  const authorRuns = task.runs.filter((r) => r.purpose === 'author' || r.purpose === 'fix');
  const last = authorRuns[authorRuns.length - 1] ?? null;
  return last ? (last.structured_result?.result ?? '') : '';
}

function capsuleForFormalReview(task, candidateId) {
  const c = task.candidate ?? {};
  const server = task.governance_env?.reviewer_server_name ?? 'agent-foundry-vault';
  const parts = [
    `You are acting as the formal reviewer inside the Vault Governance Plane.`,
    `TASK_ID: ${task.task_id}`,
    `CANDIDATE_ID: ${candidateId}`,
    `TARGET: ${c.target ?? 'n/a'}`,
    `CANDIDATE_CONTENT (assess this):`,
    `<<<`,
    task.last_author_content ?? '(author content unavailable)',
    `>>>`,
    `Steps (use the "${server}" MCP server tools):`,
    `1. Call ${server} agent_register with task_id="${task.task_id}", executor="${task.author_session_executor_type ?? 'executor'}", role="reviewer". Keep the returned agent_instance_id.`,
    `2. Call ${server} review_candidate with candidate_id="${candidateId}", agent_instance_id=<yours>, decision="approve" or "reject" per your independent assessment, reasons=<your reasons>.`,
    `Reply with ONLY a JSON object: {"agent_instance_id":"...","review_decision":"approve|reject","reasons":"..."}`,
  ];
  return {
    prompt: parts.join('\n'),
    task_id: task.task_id,
    runId: task.next_run_id ?? null,
    assigned_role: task.reviewer_role,
    cwd: task.fixture_dir,
    response_schema: null,
    mcpConfigPath: task.governance_env?.reviewer_mcp_config ?? null,
    allowedTools: task.governance_env?.reviewer_allowed_tools ?? null,
    model: task.reviewer_model || task.model,
    effort: task.reviewer_effort || task.effort,
    timeout_ms: task.timeout_ms ?? 600000,
    cline_fallback_model: task.cline_fallback_model || 'cline-pass/deepseek-v4-flash',
  };
}

async function runGovernance(task, adapters, bridge) {
  const mirror = governanceMirror(task);
  task.last_author_content = lastAuthorContent(task);
  const c = task.candidate ?? {};

  // 1. candidate creation THROUGH vault-mcp (candidate_id comes from vault).
  // PHASE 4 idempotency: if a previous crashed run already created the
  // candidate, its candidate_id is reused - never a second write_candidate.
  const pageContent = task.submission_path
    ? readFileSync(task.submission_path, 'utf8')
    : extractPageContent(task.last_author_content ?? '') || (task.last_author_content ?? '');
  let candidate_id = mirror.candidate_id ?? null;
  if (!candidate_id) {
    const created = await bridge.createCandidate({
      title: c.title ?? `${task.task_id}: ${task.goal.slice(0, 80)}`,
      content: pageContent,
      target: c.target,
      knowledge_class: c.knowledge_class,
      sources: c.sources,
      publish_tags: c.publish_tags,
      publish_summary: c.publish_summary,
      rationale: c.rationale ?? `Orchestrator task ${task.task_id} governed write`,
    });
    candidate_id = created.candidate_id;
    mirror.candidate_id = candidate_id;
    mirror.agent_instance_ids = {
      ...(mirror.agent_instance_ids ?? {}),
      bridge_requested: bridge.requested_instance_id ?? null, // minted locally, pre-registration
      bridge: created.agent_instance_id,                      // confirmed by vault-mcp
    };
    mirror.candidate_raw = created.raw_response.slice(0, 1000);
    saveTask(task);
  }

  // 2. formal review by an INDEPENDENT reviewer executor through vault-mcp.
  //    PHASE 4 idempotency: an approve verdict already persisted by a crashed
  //    run is REUSED (never a second formal review for the same verdict); a
  //    persisted reject keeps the task failed - no silent re-review.
  if (mirror.formal_review?.review_decision === 'approve') {
    // reused durable evidence from the Governance Plane
  } else {
    if (mirror.formal_review?.review_decision === 'reject') {
      throw new Error(`FORMAL_REVIEW_REJECTED: ${mirror.formal_review.reasons ?? '(no reasons)'}`);
    }
    const adapter = selectExecutor(task.reviewer_executor, { requiresMcp: true, adapters });
    const capsule = capsuleForFormalReview(task, candidate_id);
    let result = await adapter.run(capsule);
    recordRun(task, adapter.type, capsule.assigned_role, result, 'formal_review');
    const parsed = extractJson(result.structured_result?.result ?? '');
    if (result.status !== 'completed' || !parsed?.agent_instance_id || !parsed?.review_decision) {
      const classification = result.error_classification || classifyExecutionError(adapter.type, { exit_code: result.exit_code ?? 1, stderr: result.error || 'missing review JSON' });
      task.error_classification = classification;
      task.retryable = classification.retryable;
      const err = new Error(`formal review step failed or unparseable: ${result.error ?? 'missing review JSON'}`);
      err.error_classification = classification;
      throw err;
    }
    mirror.agent_instance_ids.reviewer = parsed.agent_instance_id;
    mirror.formal_review = { reviewer_instance_id: parsed.agent_instance_id, review_decision: parsed.review_decision, reasons: parsed.reasons ?? '' };
    saveTask(task);
    if (parsed.review_decision !== 'approve') {
      throw new Error(`FORMAL_REVIEW_REJECTED: ${parsed.reasons ?? '(no reasons)'}`);
    }
  }

  // 3. publish attempt: vault-mcp returns the authoritative verdict. A vault
  // rejection (e.g. REVIEW_STALE after candidate tampering) maps to deny -
  // the Governance Plane said no; the Orchestrator never retries or downgrades.
  let pub;
  try {
    pub = await bridge.publish(candidate_id);
  } catch (err) {
    if (err?.vault_rejected) {
      mirror.policy_decision = 'deny';
      mirror.policy_evidence = String(err.vault_response ?? err.message).slice(0, 1500);
      saveTask(task);
      return 'deny';
    }
    throw err;
  }
  mirror.policy_decision = pub.verdict?.policy_decision ?? 'unknown';
  mirror.published_flag = pub.verdict?.published === true;
  mirror.published_path = pub.verdict?.published_path ?? mirror.published_path ?? null;
  mirror.policy_evidence = pub.raw_response.slice(0, 1500);
  saveTask(task);
  return classifyPublishVerdict(pub.verdict);
}

async function completePublish(task, decision) {
  // A policy class is not a publish outcome: only a vault-confirmed published
  // verdict may complete a governed task.
  if (decision !== 'published') {
    throw new Error(`completePublish requires a published verdict, got ${decision}`);
  }
  task.state = 'PUBLISHING';
  saveTask(task);
  task.governance = task.governance ?? { governance_source: 'vault-mcp' };
  task.governance.publish_status = 'published';
  task.state = 'COMPLETED';
  task.completed_at = new Date().toISOString();
  saveTask(task);
  return task;
}

function makeBridge(task, override) {
  if (override) return override;
  const envCfg = task.governance_env ?? {};
  // Phase 2 closure: fail-closed. No governance_env.vault_root => no bridge,
  // no implicit real-vault fallback (GOVERNANCE_ENV_REQUIRED).
  return new GovernanceBridge({
    task_id: task.task_id,
    serverPath: envCfg.server_path,
    vaultRoot: envCfg.vault_root,
    stateDb: envCfg.state_db,
  });
}

// Re-query the Governance Plane for a task parked in WAITING_HUMAN. The local
// mirror (even if it claims "approved") is never trusted - the verdict comes
// from a fresh publish_candidate call against vault-mcp.
export async function resumeGovernance(taskId, { adapters = ADAPTERS, bridgeOverride = null, tasksDir = TASKS_DIR } = {}) {
  const task = withTasksDir(loadTask(taskId, tasksDir), tasksDir);
  if (task.state !== 'WAITING_HUMAN') {
    throw new Error(`task ${taskId} is ${task.state}, not WAITING_HUMAN`);
  }
  // PHASE 3 correlation: a resume may only continue through THIS task's own
  // saved candidate_id (re-queried against vault-mcp below). Searching for a
  // "nearest" candidate/approval/WAITING_HUMAN task is forbidden.
  if (!task.governance?.candidate_id) {
    task.state = 'FAILED';
    task.failure_reason = 'GOVERNANCE_CORRELATION_REQUIRED: WAITING_HUMAN resume requires this task\'s saved governance.candidate_id; refusing to search for a nearest candidate/approval';
    saveTask(task);
    return task;
  }
  const bridge = makeBridge(task, bridgeOverride);
  try {
    // Idempotent settle: a previous resume may have already obtained a
    // published verdict - confirm it against the vault before completing.
    const settled = await settleIfPublished(task, bridge);
    if (settled === 'published') return await completePublish(task, 'published');
    const decision = await runGovernancePublishOnly(task, bridge);
    if (decision === 'human_required') {
      task.state = 'WAITING_HUMAN'; // gate still open; keep waiting
      saveTask(task);
      return task;
    }
    if (decision === 'published') return await completePublish(task, decision);
    task.state = 'FAILED';
    task.failure_reason = 'GOVERNANCE_DENIED';
    saveTask(task);
    return task;
  } finally {
    bridge.stop?.();
  }
}

// publish-only path for resume (candidate + formal review already exist)
async function runGovernancePublishOnly(task, bridge) {
  const mirror = governanceMirror(task);
  let pub;
  try {
    pub = await bridge.publish(mirror.candidate_id);
  } catch (err) {
    if (err?.vault_rejected) {
      mirror.policy_decision = 'deny';
      mirror.policy_evidence = String(err.vault_response ?? err.message).slice(0, 1500);
      saveTask(task);
      return 'deny';
    }
    throw err;
  }
  mirror.policy_decision = pub.verdict?.policy_decision ?? 'unknown';
  mirror.published_flag = pub.verdict?.published === true;
  mirror.published_path = pub.verdict?.published_path ?? mirror.published_path ?? null;
  mirror.policy_evidence = pub.raw_response.slice(0, 1500);
  saveTask(task);
  return classifyPublishVerdict(pub.verdict);
}

// Idempotent settle for a task whose previous resume already obtained a
// published verdict: confirm the published file against the vault (truth)
// via a read-only vault_read before completing. A forged published_path
// fails the read and falls through to the normal publish flow.
async function settleIfPublished(task, bridge) {
  const mirror = governanceMirror(task);
  if (!mirror.published_flag || !mirror.published_path) return null;
  try {
    await bridge.client.call('vault_read', { path: mirror.published_path });
    return 'published'; // vault-confirmed: the file is really there
  } catch (err) {
    // Only a vault-level rejection ("that file is not there") downgrades the
    // claim. Any other failure (bridge misconfigured, client undefined, timeout)
    // must propagate: silently clearing the flag would republish a page that may
    // already be live.
    if (!err?.vault_rejected) throw err;
    mirror.published_flag = false; // claim not confirmed by vault; republish
    saveTask(task);
    return null;
  }
}

async function executeSingleStep(step, task, adapters, { lastAuthorExecutorType, onRunStart, cwd }) {
  const plan = task.planner_result.plan;
  let executorId = step.executor || task.step_executors?.[step.step];
  if (!executorId) {
    if (step.role === 'researcher') {
      executorId = task.researcher_executor || (adapters.claude ? 'claude' : 'codex');
    } else if (step.role === 'reviewer' || step.role === 'verifier') {
      executorId = task.reviewer_executor || (lastAuthorExecutorType === 'codex' && adapters.cline ? 'cline' : 'cline');
    } else {
      executorId = task.author_executor || 'codex';
    }
  }

  const adapter = selectExecutor(executorId, { requiresMcp: !!task.requires_mcp, adapters });
  const runId = `RUN-S${step.step}-${randomUUID().slice(0, 8)}`;
  task.next_run_id = runId;
  onRunStart?.(runId, adapter.type);

  const priorSummary = (task.plan_execution || [])
    .map((pe) => `- Step ${pe.step} [${pe.role}] by ${pe.executor}: ${pe.summary || 'done'}`)
    .join('\n');

  const stepCwd = cwd || task.fixture_dir;

  const promptParts = [
    `You are acting as the ${step.role} in Step ${step.step} of ${plan.length} for task ${task.task_id}.`,
    `OVERALL GOAL: ${task.goal}`,
    `CURRENT STEP GOAL: ${step.goal}`,
    `CURRENT STEP SPECIFICATION: ${step.description}`,
    `WORKING DIRECTORY: ${stepCwd}`,
    `RED LINES: ${task.red_lines.join('; ')}`,
    priorSummary ? `PRIOR COMPLETED STEPS:\n${priorSummary}` : '',
    `Perform the necessary work directly in the working directory. Ensure modularity, clean code, and runnable tests.`,
    `When finished, output a concise 1-2 sentence summary of what was accomplished and files created/updated.`,
  ].filter(Boolean);

  const capsule = {
    prompt: promptParts.join('\n\n'),
    task_id: `${task.task_id}-S${step.step}`,
    runId,
    assigned_role: step.role,
    cwd: stepCwd,
    acceptEdits: step.role !== 'reviewer',
    model: executorId === 'codex' ? (task.author_model || 'gpt-5.6-luna') : (executorId === 'cline' ? (task.cline_model || task.reviewer_model) : undefined),
    effort: executorId === 'codex' ? (task.author_effort || 'max') : (executorId === 'cline' ? (task.cline_effort || task.reviewer_effort || 'xhigh') : undefined),
    timeout_ms: task.timeout_ms ?? 900000,
    protect_active_process: task.protect_active_process !== false,
    idle_timeout_ms: task.idle_timeout_ms ?? 900000,
    cline_fallback_model: task.cline_fallback_model || 'cline-pass/deepseek-v4-flash',
    cline_fallback_effort: task.cline_fallback_effort || 'xhigh',
  };

  const result = await adapter.run(capsule);
  result.executor_run_id = runId;
  recordRun(task, adapter.type, step.role, result, `step_${step.step}`);

  if (result.status === 'cancelled') {
    const err = new Error(`step ${step.step} cancelled by operator`);
    err.code = 'RUN_CANCELLED';
    throw err;
  }

  if (result.status !== 'completed') {
    const classification = result.error_classification || classifyExecutionError(adapter.type, { exit_code: result.exit_code ?? 1, stderr: result.error || 'run failed' });
    task.error_classification = classification;
    task.retryable = classification.retryable;
    const err = new Error(`step ${step.step} failed: ${result.error}`);
    err.error_classification = classification;
    throw err;
  }

  const summaryText = result.structured_result?.result || (result.stdout ? result.stdout.slice(0, 300) : 'Step completed successfully');
  task.plan_execution.push({
    step: step.step,
    goal: step.goal,
    role: step.role,
    executor: adapter.type,
    status: 'completed',
    summary: summaryText,
    finished_at: new Date().toISOString(),
  });

  return { runId, executorType: adapter.type, summaryText };
}

async function executePlannedSteps(task, adapters, { governanceBridge = null, targetCoordination = null, onRunStart = null } = {}) {
  task.plan_execution = task.plan_execution ?? [];
  const plan = task.planner_result.plan;
  const batches = buildPlanBatches(plan);

  console.log(`[orchestrator] Executing multi-step plan for task ${task.task_id} (${plan.length} steps in ${batches.length} batches)`);

  let lastAuthorRunId = null;
  let lastAuthorExecutorType = null;

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    const pendingSteps = batch.filter((step) =>
      !task.plan_execution.some((p) => p.step === step.step && p.status === 'completed')
    );
    if (pendingSteps.length === 0) {
      console.log(`[orchestrator] Batch ${bIdx + 1}/${batches.length} already completed, skipping`);
      continue;
    }

    const useWorktree = (pendingSteps.length > 1 || pendingSteps.some((s) => s.isolation === 'worktree')) && task.enable_worktree !== false;

    if (!useWorktree) {
      // Sequential single-writer execution
      for (const step of pendingSteps) {
        console.log(`[orchestrator] >>> Step ${step.step}/${plan.length} [${step.role}]: ${step.goal}`);
        task.current_step = step.step;
        task.current_step_goal = step.goal;
        task.current_step_role = step.role;
        task.state = `${step.role.toUpperCase()}_RUNNING`;
        saveTask(task);

        const stepExecRes = await executeSingleStep(step, task, adapters, {
          lastAuthorExecutorType,
          onRunStart,
          cwd: task.fixture_dir,
        });

        if (step.role === 'author' || step.role === 'worker') {
          lastAuthorRunId = stepExecRes.runId;
          lastAuthorExecutorType = stepExecRes.executorType;
        }
        saveTask(task);
      }
    } else {
      // Parallel execution with Git Worktree Isolation
      console.log(`[orchestrator] >>> Parallel Batch ${bIdx + 1}/${batches.length}: Running ${pendingSteps.length} steps concurrently in isolated Git worktrees`);
      task.state = 'PARALLEL_RUNNING';
      saveTask(task);

      const session = new WorktreeSession({ repoDir: task.fixture_dir, taskId: task.task_id });
      session.init();

      try {
        await Promise.all(pendingSteps.map(async (step) => {
          console.log(`[orchestrator] [Worktree] Initializing isolated worktree for Step ${step.step} [${step.role}]: ${step.goal}`);
          const wt = session.createStepWorktree(step.step);

          const stepExecRes = await executeSingleStep(step, task, adapters, {
            lastAuthorExecutorType,
            onRunStart,
            cwd: wt.worktreeDir,
          });

          if (step.role === 'author' || step.role === 'worker') {
            lastAuthorRunId = stepExecRes.runId;
            lastAuthorExecutorType = stepExecRes.executorType;
          }

          // Auto-commit changes in worktree
          session.commitStep(step.step, `feat(step-${step.step}): ${step.goal}`);
        }));

        // Sequentially merge all completed step branches into main
        for (const step of pendingSteps) {
          console.log(`[orchestrator] [Worktree] Merging step ${step.step} branch into main...`);
          const mergeRes = session.mergeStep(step.step);
          if (!mergeRes.success) {
            const err = new Error(`Merge conflict in parallel step ${step.step} (${step.goal}): ${mergeRes.conflictingFiles?.join(', ') || mergeRes.error}`);
            err.code = 'MERGE_CONFLICT';
            throw err;
          }
        }
        saveTask(task);
      } finally {
        // A failed step must not leave its siblings running while the worktrees
        // they are writing into are torn down. Terminate every active run of
        // this task first, then clean up.
        try {
          const { cancelTaskRuns } = await import('./lib/adapters.mjs');
          await cancelTaskRuns(task.task_id);
        } catch { /* best effort: cleanup must still happen */ }
        session.cleanupAll();
      }
    }
  }

  // Final verification & acceptance
  console.log('[orchestrator] All plan steps completed, running final acceptance gate...');
  const acc = await acceptanceGate(task, 1);
  if (!acc.ok) {
    throw new Error(`Final acceptance test failed: ${acc.record?.failure_reason || acc.output}`);
  }

  task.state = 'COMPLETED';
  task.completed_at = new Date().toISOString();
  saveTask(task);
  console.log(`[orchestrator] Multi-step task ${task.task_id} successfully COMPLETED!`);
  return task;
}


export async function executeTask(task, adapters = ADAPTERS, { governanceBridge = null, targetCoordination = null, onRunStart = null, isShutdownRequested = null, shutdownMode = null } = {}) {
  // Never revive a task that already reached a terminal state, and never start
  // an executor for one the operator already cancelled: the on-disk task is the
  // lifecycle truth, so a stale in-memory copy must not overwrite it.
  try {
    const onDiskAtEntry = loadTask(task.task_id, tasksDirOf(task));
    if (NON_REVIVABLE_STATES.has(onDiskAtEntry.state)) return onDiskAtEntry;
    if (onDiskAtEntry.cancel_requested_at) {
      task.cancel_requested_at = onDiskAtEntry.cancel_requested_at;
      task.cancelled_by = onDiskAtEntry.cancelled_by ?? task.cancelled_by;
      task.cancel_reason = task.cancel_reason ?? 'cancelled by operator before execution';
      task.state = 'CANCELLED';
      task.cancelled_at = task.cancelled_at ?? new Date().toISOString();
      task.retryable = false;
      saveTask(task);
      return task;
    }
  } catch { /* task not persisted yet (programmatic callers, tests) */ }

  // tolerate minimally-shaped task objects (tests, programmatic callers)
  task.runs = task.runs ?? [];
  task.revisions_used = task.revisions_used ?? 1;
  task.author_role = task.author_role ?? 'author';
  task.reviewer_role = task.reviewer_role ?? 'reviewer';
  task.red_lines = Array.isArray(task.red_lines) ? task.red_lines : [];
  task.review_rules = Array.isArray(task.review_rules) ? task.review_rules : [];
  task.fixture_dir = task.fixture_dir ?? '/tmp';
  task.acceptance = task.acceptance ?? (task.goal || '');
  if (task.task_mode === 'governed_write') {
    // governed tasks imply unattended MCP steps (formal review via vault-mcp)
    task.requires_mcp = true;
  }
  task.state = 'AUTHOR_RUNNING';
  saveTask(task);
  try {
    if (task.multi_step_dispatch && Array.isArray(task.planner_result?.plan) && task.planner_result.plan.length > 1) {
      return await executePlannedSteps(task, adapters, { governanceBridge, targetCoordination, onRunStart });
    }
    await runAuthor(task, 1, adapters, { onRunStart });
    if (task.task_mode === 'governed_write') stageSubmission(task);
    return await runLoopFromReview(task, 1, adapters, { governanceBridge, targetCoordination, onRunStart });
  } catch (err) {
    const isShutdown = typeof isShutdownRequested === 'function' ? isShutdownRequested() : !!isShutdownRequested;
    const sMode = typeof shutdownMode === 'function' ? shutdownMode() : shutdownMode;
    if (isShutdown) {
      if (sMode === 'interrupt' || err?.code !== 'RUN_CANCELLED') {
        task.interrupted_at = new Date().toISOString();
        task.interrupted_reason = 'shutdown requested during task execution';
        saveTask(task);
        return task;
      }
    }
    if (err?.code === 'RUN_CANCELLED') {
      try {
        const onDisk = loadTask(task.task_id, tasksDirOf(task));
        if (onDisk.termination) task.termination = onDisk.termination;
        if (onDisk.cancel_requested_at) task.cancel_requested_at = onDisk.cancel_requested_at;
        if (onDisk.cancelled_by) task.cancelled_by = onDisk.cancelled_by;
      } catch { /* ignore */ }
      task.state = 'CANCELLED';
      task.cancelled_at = task.cancelled_at ?? new Date().toISOString();
      task.cancel_reason = task.cancel_reason ?? 'cancelled while executor run was active';
      task.retryable = false;
      saveTask(task);
      return task;
    }
    // A non-revivable state already on disk wins: an operator cancellation that
    // landed while this run was unwinding must not be overwritten with FAILED.
    try {
      const onDisk = loadTask(task.task_id, tasksDirOf(task));
      if (NON_REVIVABLE_STATES.has(onDisk.state)) return onDisk;
    } catch { /* ignore */ }
    task.state = 'FAILED';
    task.failure_reason = String(err?.message ?? err);
    if (err?.error_classification) {
      task.error_classification = err.error_classification;
      task.retryable = err.error_classification.retryable;
    } else {
      const classification = classifyExecutionError(task.author_session_executor_type || task.author_executor, {
        exit_code: 1,
        stderr: task.failure_reason,
      });
      task.error_classification = classification;
      task.retryable = classification.retryable;
    }
    saveTask(task);
    return task;
  }
}

// The review→acceptance→governance loop, re-entrant from any revision.
// Extracted in PHASE 4 so continueTask can resume an interrupted task from
// its durable state without re-running stages whose results are already
// persisted.
async function runLoopFromReview(task, revision, adapters, { governanceBridge = null, targetCoordination = null, reuseReview = false, onRunStart = null } = {}) {
  const maxRevisions = task.max_revisions ?? MAX_REVISIONS_DEFAULT;
  try {
    for (;;) {
      task.state = 'REVIEW_RUNNING';
      task.review_revision = revision;
      saveTask(task);
      let review;
      if (reuseReview && reviewResultPersisted(task) && Number(task.last_review?.revision ?? -1) === Number(revision)) {
        // PHASE 4: crash happened AFTER the reviewer finished but BEFORE its
        // decision was applied - reuse the persisted result, never re-call the
        // reviewer for a decision that already exists.
        review = task.last_review;
      } else {
        review = await runReview(task, revision, adapters, { onRunStart });
      }
      if (review.decision === 'PASS') {
        // Deterministic acceptance gate. A failure here consumes the SAME
        // revision budget as a reviewer NEEDS_FIX (Phase 1.1).
        const acc = await acceptanceGate(task, revision);
        if (acc.ok) {
          if (task.task_mode !== 'governed_write') {
            task.state = 'COMPLETED';
            task.completed_at = new Date().toISOString();
            task.final_review = review;
            saveTask(task);
            return task;
          }
          // Phase 2: QA PASS is NOT the end for governed_write - hand over to
          // the existing Governance Plane and map its verdict back.
          task.state = 'GOVERNANCE_PENDING';
          saveTask(task);
          // PHASE 3 target coordination (Control Plane optimization ONLY):
          // two active tasks must not enter the publish-sensitive stage on
          // the same candidate target. This is coordination, NOT enforcement:
          // the formal writer conflict decision stays with vault-mcp's writer
          // lock - never a silent last-write-wins.
          if (targetCoordination && task.candidate?.target && !targetCoordination.acquire(task)) {
            task.state = 'FAILED';
            task.failure_reason = 'WRITE_CONFLICT';
            task.failure_detail = `target ${JSON.stringify(task.candidate.target)} is already held in the publish-sensitive stage by another active task (control-plane coordination; formal enforcement remains the vault-mcp writer lock)`;
            saveTask(task);
            return task;
          }
          const bridge = makeBridge(task, governanceBridge);
          let decision;
          try {
            decision = await runGovernance(task, adapters, bridge);
          } finally {
            bridge.stop?.();
          }
          if (decision === 'published') return await completePublish(task, decision);
          if (decision === 'human_required') {
            task.state = 'WAITING_HUMAN';
            saveTask(task);
            return task; // parked; user completes the real Human Gate, then resume
          }
          task.state = 'FAILED';
          task.failure_reason = decision === 'deny' ? 'GOVERNANCE_DENIED' : `GOVERNANCE_UNKNOWN_${String(decision).toUpperCase()}`;
          saveTask(task);
          return task;
        }
        task.last_acceptance_failure = acc.record;
        review = {
          decision: 'NEEDS_FIX',
          summary: 'reviewer PASSed but the deterministic acceptance command failed',
          issues: [...(review.issues ?? []), 'acceptance command failed'],
          required_changes: [...(review.required_changes ?? []),
            `Make this command pass: ${JSON.stringify(task.acceptance_cmd)}\nexit_code: ${acc.record.exit_code}\nstdout: ${acc.record.stdout_summary}\nstderr: ${acc.record.stderr_summary}`],
          evidence: [...(review.evidence ?? []), 'orchestrator acceptance run'],
        };
      }
      if (revision >= maxRevisions) {
        task.state = 'FAILED';
        task.failure_reason = 'MAX_REVISIONS_EXCEEDED';
        saveTask(task);
        return task;
      }
      revision += 1;
      task.revisions_used = revision;
      task.state = 'NEEDS_FIX';
      saveTask(task);
      // A distinct state: the fix resumes the ORIGINAL author session with the
      // persisted feedback, so a crash here is safe to re-run. A crash during
      // an AUTHOR_RUNNING run has an UNKNOWN outcome and must not be.
      task.state = 'FIX_RUNNING';
      saveTask(task);
      await runAuthor(task, revision, adapters, { onRunStart }); // resume original author session
      if (task.task_mode === 'governed_write') stageSubmission(task);
    }
  } catch (err) {
    // A non-revivable state already on disk wins: an operator cancellation that
    // landed while this run was unwinding must not be overwritten with FAILED.
    try {
      const onDisk = loadTask(task.task_id, tasksDirOf(task));
      if (NON_REVIVABLE_STATES.has(onDisk.state)) return onDisk;
    } catch { /* ignore */ }
    task.state = 'FAILED';
    task.failure_reason = String(err?.message ?? err);
    if (err?.error_classification) {
      task.error_classification = err.error_classification;
      task.retryable = err.error_classification.retryable;
    } else {
      const classification = classifyExecutionError(task.reviewer_executor || 'executor', {
        exit_code: 1,
        stderr: task.failure_reason,
      });
      task.error_classification = classification;
      task.retryable = classification.retryable;
    }
    saveTask(task);
    return task;
  }
}

// PHASE 4: resume an interrupted task from its durable state. The switch
// below maps each persisted state onto the smallest safe continuation - it
// never re-runs stages whose results are already persisted, never fakes
// outcomes, and defers all governance truth to vault-mcp.
export async function continueTask(taskId, adapters = ADAPTERS, { governanceBridge = null, targetCoordination = null, tasksDir = TASKS_DIR } = {}) {
  const task = withTasksDir(loadTask(taskId, tasksDir), tasksDir);
  task.runs = task.runs ?? [];
  task.revisions_used = task.revisions_used ?? 1;
  task.author_role = task.author_role ?? 'author';
  task.reviewer_role = task.reviewer_role ?? 'reviewer';
  if (task.task_mode === 'governed_write') task.requires_mcp = true;

  if (TERMINAL_STATES.has(task.state)) {
    throw Object.assign(new Error(`TASK_TERMINAL: task ${taskId} is ${task.state} - recovery refused`), { code: 'TASK_TERMINAL' });
  }

  if (task.state === 'WAITING_HUMAN') {
    // durable park: re-query the vault truth by THIS task's candidate_id only
    return await resumeGovernance(taskId, { adapters, bridgeOverride: governanceBridge, tasksDir });
  }

  if (task.state === 'PUBLISHING') {
    if (!task.governance?.candidate_id) {
      throw Object.assign(new Error('UNSAFE_TO_AUTO_RESUME: PUBLISHING without candidate_id - publish outcome cannot be correlated'), { code: 'UNSAFE_TO_AUTO_RESUME' });
    }
    const bridge = makeBridge(task, governanceBridge);
    try {
      const settled = await settleIfPublished(task, bridge); // vault truth first
      if (settled === 'published') return await completePublish(task, 'published');
      const decision = await runGovernancePublishOnly(task, bridge);
      if (decision === 'published') return await completePublish(task, decision);
      if (decision === 'human_required') { task.state = 'WAITING_HUMAN'; saveTask(task); return task; }
      task.state = 'FAILED';
      task.failure_reason = decision === 'deny' ? 'GOVERNANCE_DENIED' : `GOVERNANCE_UNKNOWN_${String(decision).toUpperCase()}`;
      saveTask(task);
      return task;
    } finally {
      bridge.stop?.();
    }
  }

  if (task.state === 'GOVERNANCE_PENDING') {
    // author content is durable; governance resumes idempotently (existing
    // candidate_id / approve verdict are reused, never rebuilt)
    const bridge = makeBridge(task, governanceBridge);
    try {
      const decision = await runGovernance(task, adapters, bridge);
      if (decision === 'published') return await completePublish(task, decision);
      if (decision === 'human_required') { task.state = 'WAITING_HUMAN'; saveTask(task); return task; }
      task.state = 'FAILED';
      task.failure_reason = decision === 'deny' ? 'GOVERNANCE_DENIED' : `GOVERNANCE_UNKNOWN_${String(decision).toUpperCase()}`;
      saveTask(task);
      return task;
    } finally {
      bridge.stop?.();
    }
  }

  if (task.state === 'AUTHOR_RUNNING' && !authorResultPersisted(task, task.revisions_used ?? 1)) {
    // the author run died mid-flight: record the interrupted run explicitly
    // (UNKNOWN_OUTCOME) - never a fake FAILED/PASS - and refuse auto-continuation
    markInterruptedRun(task, 'author');
    throw Object.assign(new Error('INTERRUPTED: author run has no durable result (UNKNOWN_OUTCOME) - manual decision required (re-run author from scratch or discard)'), { code: 'AUTHOR_INTERRUPTED' });
  }

  if (task.state === 'NEEDS_FIX' || task.state === 'FIX_RUNNING') {
    // durable review feedback + original author session -> exact resume fix.
    // FIX_RUNNING means the fix was interrupted before producing anything, which
    // is safe to re-run; NEEDS_FIX means the fix has not started either.
    task.state = 'AUTHOR_RUNNING';
    saveTask(task);
    const revision = task.revisions_used ?? 1;
    await runAuthor(task, revision, adapters);
    if (task.task_mode === 'governed_write') stageSubmission(task);
    return await runLoopFromReview(task, revision, adapters, { governanceBridge, targetCoordination });
  }

  // REVIEW_RUNNING, or AUTHOR_RUNNING with a fully persisted author result:
  // the author is NOT re-run; only the remaining stages execute. If the
  // reviewer already finished (result persisted, revision matches) its
  // decision is reused instead of re-calling the reviewer.
  const revision = task.review_revision ?? task.revisions_used ?? 1;
  const reuseReview = task.state === 'REVIEW_RUNNING'
    && reviewResultPersisted(task)
    && Number(task.last_review?.revision ?? -1) === Number(revision);
  return await runLoopFromReview(task, revision, adapters, { governanceBridge, targetCoordination, reuseReview });
}

// records an interrupted run placeholder: UNKNOWN_OUTCOME, never FAILED/PASS
function markInterruptedRun(task, purpose) {
  task.runs = task.runs ?? [];
  const id = `RUN-INT-${randomUUID().slice(0, 8)}`;
  task.runs.push({
    executor_run_id: id,
    executor_type: task.author_session_executor_type ?? 'unknown',
    assigned_role: purpose === 'review' ? (task.reviewer_role ?? 'reviewer') : (task.author_role ?? 'author'),
    purpose,
    status: 'interrupted',
    execution_outcome: 'interrupted',
    session_ref: null,
    exit_code: null,
    started_at: null,
    finished_at: null,
    error: 'UNKNOWN_OUTCOME: orchestrator process died before this run finished',
  });
  saveTask(task);
  return id;
}

function loadTaskFile(path) {
  const def = JSON.parse(readFileSync(path, 'utf8'));
  const now = new Date().toISOString();
  // validate acceptance command shape early (trust boundary entry point);
  // legacy shell strings are forbidden unless the task file explicitly allows
  normalizeAcceptanceCmd(def.acceptance_cmd, {
    allowLegacy: def.allow_legacy_shell_acceptance === true,
  });
  if ((def.task_mode ?? 'workspace') === 'governed_write' && !def.governance_env?.vault_root) {
    // fail-closed at load time: a governed task without an explicit target
    // vault must not run at all (it could otherwise fall back to the real
    // vault - the exact Phase 2 leak this closes).
    const err = new Error('GOVERNANCE_ENV_REQUIRED: governed_write task must declare governance_env.vault_root (no implicit real-vault fallback)');
    err.code = 'GOVERNANCE_ENV_REQUIRED';
    throw err;
  }
  const task = {
    task_id: def.task_id,
    task_mode: def.task_mode ?? 'workspace', // workspace | governed_write
    goal: def.goal,
    acceptance: def.acceptance,
    acceptance_cmd: def.acceptance_cmd ?? null,
    allow_legacy_shell_acceptance: def.allow_legacy_shell_acceptance === true,
    candidate: def.candidate ?? null, // governed_write: {title, target, knowledge_class, sources, publish_tags, publish_summary, rationale}
    governance_env: def.governance_env ?? null, // {server_path, vault_root, state_db, reviewer_mcp_config, reviewer_allowed_tools, reviewer_server_name}
    red_lines: def.red_lines ?? [],
    review_rules: def.review_rules ?? [],
    fixture_dir: def.fixture_dir,
    requires_mcp: !!def.requires_mcp,
    author_executor: def.author_executor ?? 'auto',
    reviewer_executor: def.reviewer_executor ?? 'auto',
    author_role: def.author_role ?? 'author',
    reviewer_role: 'reviewer',
    max_revisions: def.max_revisions ?? MAX_REVISIONS_DEFAULT,
    timeout_ms: def.timeout_ms,
    state: 'CREATED',
    state_version: 0,
    created_at: now,
    updated_at: now,
    runs: [],
    revisions_used: 1,
    planner_result: def.planner_result ?? null,
    multi_step_dispatch: def.multi_step_dispatch ?? false,
    plan_execution: def.plan_execution ?? [],
    step_executors: def.step_executors ?? null,
    author_model: def.author_model,
    author_effort: def.author_effort,
    researcher_executor: def.researcher_executor ?? null,
  };
  if (!task.goal || !task.acceptance || !task.fixture_dir) {
    throw new Error('task file must define goal, acceptance, fixture_dir');
  }
  if (task.task_mode === 'governed_write' && !task.candidate?.target) {
    throw new Error('governed_write tasks must define candidate.target');
  }
  // Bind the acceptance trust anchor to the validated definition, so a later
  // edit of tasks/<id>.json is detected before the command is executed.
  task.acceptance_binding = acceptanceBinding(task);
  saveTask(task);
  return task;
}

function inspectTask(task, { locksDir = null, recovery = null } = {}) {
  const lastRun = task.runs[task.runs.length - 1] ?? null;
  const lastReviewRun = [...task.runs].reverse().find((r) => r.purpose === 'review') ?? null;
  const interrupted = RUNNING_STATES.has(task.state);
  const out = {
    task_id: task.task_id,
    status: task.state,
    revision: task.revisions_used,
    state_version: task.state_version ?? 0,
    author_session_ref: task.author_session_ref ?? null,
    author_session_executor_type: task.author_session_executor_type ?? null,
    latest_reviewer_result: task.last_review
      ? { decision: task.last_review.decision, summary: task.last_review.summary }
      : null,
    latest_executor_run: lastRun,
    latest_review_run_id: lastReviewRun?.executor_run_id ?? null,
    last_error: task.failure_reason ?? task.runs.find((r) => r.error)?.error ?? null,
  };
  // PHASE 4: lock owner / staleness and the recovery classification
  if (locksDir) {
    const lock = readLock(locksDir, task.task_id);
    if (lock) {
      out.lock_owner = lock.orchestrator_instance_id ?? null;
      out.lock_pid = lock.pid ?? null;
      out.lock_stale = isLockStale(lock);
    }
  }
  if (recovery) {
    out.recovery_class = recovery.recovery_class;
    out.recommended_action = recovery.recommended_action ?? null;
    if (recovery.reason) out.recovery_reason = recovery.reason;
    out.recoverable = recovery.recoverable ?? null;
  }
  if (task.scheduler_state) out.scheduler_state = task.scheduler_state;
  if (interrupted) {
    // A task found in a running state with no live orchestrator process was
    // interrupted. Never report it as COMPLETED (Phase 1.1: no fake success).
    out.interrupted_stage = task.state;
    out.recoverable = out.recoverable ?? !!(task.author_session_ref && task.author_session_executor_type);
    out.note = 'task was left in a running state; use recover --task-id to resume safely';
  }
  if (task.cancelled_at) {
    out.cancellation = {
      cancel_requested_at: task.cancel_requested_at ?? null,
      cancelled_at: task.cancelled_at,
      cancel_reason: task.cancel_reason ?? null,
      cancelled_by: task.cancelled_by ?? null,
      active_run_id: task.active_run_id ?? null,
    };
  }
  if (task.governance) {
    out.governance = {
      governance_source: task.governance.governance_source,
      candidate_id: task.governance.candidate_id ?? null,
      policy_decision: task.governance.policy_decision ?? null,
      human_gate_status: task.governance.human_gate_status ?? null,
      publish_status: task.governance.publish_status ?? null,
    };
  }
  return out;
}

export function installGracefulShutdown(scheduler, opts = {}) {
  if (!scheduler) throw new Error('scheduler is required for installGracefulShutdown');
  return scheduler.installSignalHandlers(opts);
}

// PHASE 9-A / 9-C / 9-D: Gateway submission, Planner integration, and Human Intent Alignment Gate
// Connects Gateway -> Planner Layer -> Human Intent Alignment Gate -> Orchestrator -> Scheduler
export async function submitTask(taskCapsule, {
  scheduler = null,
  autoRun = false,
  tasksDir = null,
  withPlan = true,
  withIntentGate = true,
} = {}) {
  if (!taskCapsule || typeof taskCapsule !== 'object') {
    throw new Error('submitTask requires a valid taskCapsule object');
  }

  const dir = tasksDir || TASKS_DIR;

  if (!taskCapsule.task_id) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    taskCapsule.task_id = `TASK-${today}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  // PHASE 9-C: If task has goal and no planner_result, invoke Planner Layer
  if (withPlan && !taskCapsule.planner_result && taskCapsule.goal) {
    try {
      const { planTask } = await import('./planner/planner.mjs');
      const plan = await planTask(taskCapsule);
      taskCapsule.planner_result = plan;
    } catch {
      // Continue fail-safe if planning error or custom testing hook
    }
  }

  // PHASE 9-D: Human Intent Alignment Gate
  if (withIntentGate) {
    const { alignTaskIntent } = await import('./approval/intent-gate.mjs');
    const alignment = alignTaskIntent(taskCapsule, taskCapsule.planner_result, { tasksDir: dir });
    if (alignment.required) {
      return {
        task_id: taskCapsule.task_id,
        status: 'WAITING_HUMAN',
        intent_alignment: taskCapsule.intent_alignment,
        planner_result: taskCapsule.planner_result ?? null,
        scheduler: scheduler || null,
      };
    }
  }

  const { Scheduler } = await import('./lib/scheduler.mjs');
  const sched = scheduler || new Scheduler({ tasksDir: dir });
  const taskId = sched.enqueue(taskCapsule);
  if (autoRun) {
    sched.runNext();
  }
  return {
    task_id: taskId,
    status: 'ACCEPTED',
    scheduler: sched,
    intent_alignment: taskCapsule.intent_alignment ?? null,
    planner_result: taskCapsule.planner_result ?? null,
  };
}

export async function approveTaskIntent(taskId, {
  reason = '确认执行该方案',
  approvedBy = 'user',
  tasksDir = null,
  scheduler = null,
  autoRun = false,
} = {}) {
  if (!taskId) throw new Error('approveTaskIntent requires taskId');
  const dir = tasksDir || TASKS_DIR;
  const { approveIntent } = await import('./approval/intent-gate.mjs');
  const res = approveIntent(taskId, { reason, approvedBy, tasksDir: dir });

  // Task is now APPROVED. Enqueue into Scheduler
  const { Scheduler } = await import('./lib/scheduler.mjs');
  const sched = scheduler || new Scheduler({ tasksDir: dir });
  const task = loadTask(taskId, dir);
  sched.enqueue(task);
  if (autoRun) {
    sched.runNext();
  }

  return {
    task_id: taskId,
    status: 'APPROVED',
    message: reason,
    scheduler: sched,
    task,
  };
}

export async function rejectTaskIntent(taskId, {
  reason = '方向不符合要求',
  rejectedBy = 'user',
  tasksDir = null,
} = {}) {
  if (!taskId) throw new Error('rejectTaskIntent requires taskId');
  const dir = tasksDir || TASKS_DIR;
  const { rejectIntent } = await import('./approval/intent-gate.mjs');
  const res = rejectIntent(taskId, { reason, rejectedBy, tasksDir: dir });

  return {
    task_id: taskId,
    status: 'CANCELLED',
    message: reason,
    task: res.task,
  };
}

export function getTaskStatus(taskId, { tasksDir = null } = {}) {
  if (!taskId) throw new Error('getTaskStatus requires taskId');
  const dir = tasksDir || TASKS_DIR;
  const task = loadTask(taskId, dir);
  const lastRun = Array.isArray(task.runs) && task.runs.length ? task.runs[task.runs.length - 1] : null;
  const executor = lastRun?.executor_type || task.author_session_executor_type || task.author_executor || null;
  return {
    task_id: task.task_id,
    state: task.state,
    executor,
  };
}

// CLI entry point - only when executed directly, not when imported by tests
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [, , cmd, ...rest] = process.argv;
function argValue(flag) {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : null;
}

// The CLI is a Control Plane owner in its own right: `run` and `resume` used to
// execute a task with no lock at all, so two operators could drive the same task
// concurrently. The lock is taken here (not inside the library entry points,
// which recovery already calls while holding one) and released in a finally, so
// a refusal leaves no lock behind.
async function withTaskLock(taskId, fn) {
  const { acquireTaskLock, releaseTaskLock } = await import('./lib/tasklock.mjs');
  let lockInfo;
  try {
    lockInfo = acquireTaskLock(LOCKS_DIR, taskId, { orchestratorInstanceId: `af-cli-${process.pid}` });
  } catch (err) {
    console.error(`[orchestrator] ${err.message}`);
    process.exit(3);
  }
  if (lockInfo.stale_lock_recovered) {
    console.log(`[orchestrator] recovered a stale lock for ${taskId} (${lockInfo.recovered_from?.stale_reason ?? 'unknown'})`);
  }
  try {
    return await fn();
  } finally {
    releaseTaskLock(LOCKS_DIR, taskId, lockInfo.lock);
  }
}

if (isMain) {
  if (cmd === 'run') {
    const { terminateAllActiveRuns } = await import('./lib/adapters.mjs');
    const onSignal = async (sig) => {
      console.log(`[orchestrator] Received ${sig}, gracefully terminating active executor runs...`);
      await terminateAllActiveRuns();
      process.exit(130);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    const task = loadTaskFile(argValue('--task-file'));
    console.log(`[orchestrator] task=${task.task_id} author=${task.author_executor} reviewer=${task.reviewer_executor} max_revisions=${task.max_revisions}`);
    const done = await withTaskLock(task.task_id, () => executeTask(task));
    console.log(`[orchestrator] final state: ${done.state}${done.failure_reason ? ` (${done.failure_reason})` : ''}`);
    console.log(JSON.stringify({
      task_id: done.task_id,
      state: done.state,
      revisions_used: done.revisions_used,
      acceptance_runs: (done.acceptance_runs ?? []).map((a) => `${a.command} exit=${a.exit_code}`),
      runs: done.runs.map((r) => `${r.purpose}:${r.executor_type}:${r.status}:${r.executor_run_id}`),
      failure_reason: done.failure_reason ?? null,
    }, null, 2));
    process.exit(done.state === 'COMPLETED' ? 0 : 1);
  } else if (cmd === 'submit') {
    const taskFilePath = argValue('--task-file');
    if (!taskFilePath) { console.error('usage: orchestrator.mjs submit --task-file <json>'); process.exit(2); }
    const taskCapsule = JSON.parse(readFileSync(taskFilePath, 'utf8'));
    const autoRun = rest.includes('--auto-run') || rest.includes('--run');
    const res = await submitTask(taskCapsule, { autoRun });
    console.log(JSON.stringify({ task_id: res.task_id, status: res.status, message: 'Task submitted to Agent Foundry' }, null, 2));
    process.exit(0);
  } else if (cmd === 'approve') {
    const tid = argValue('--task-id');
    if (!tid) { console.error('usage: orchestrator.mjs approve --task-id <id> [--reason <reason>]'); process.exit(2); }
    const reason = argValue('--reason') || '确认执行该方案';
    const autoRun = rest.includes('--auto-run') || rest.includes('--run');
    const res = await approveTaskIntent(tid, { reason, autoRun });
    console.log(JSON.stringify({ task_id: res.task_id, status: res.status, message: res.message }, null, 2));
    process.exit(0);
  } else if (cmd === 'reject') {
    const tid = argValue('--task-id');
    if (!tid) { console.error('usage: orchestrator.mjs reject --task-id <id> [--reason <reason>]'); process.exit(2); }
    const reason = argValue('--reason') || '方向不符合要求';
    const res = await rejectTaskIntent(tid, { reason });
    console.log(JSON.stringify({ task_id: res.task_id, status: res.status, message: res.message }, null, 2));
    process.exit(0);
  } else if (cmd === 'status') {
    const tid = argValue('--task-id');
    let t;
    try {
      t = loadTask(tid);
    } catch (err) {
      // An operator asking about an unknown task should get one clear line, not
      // an uncaught exception and a raw stack trace.
      console.error(`[orchestrator] ${String(err?.message ?? err)}`);
      process.exit(2);
    }
    console.log(JSON.stringify(t, null, 2));
  } else if (cmd === 'inspect') {
    const tid = argValue('--task-id');
    let t;
    try {
      t = loadTask(tid);
    } catch (err) {
      console.error(`[orchestrator] ${String(err?.message ?? err)}`);
      process.exit(2);
    }
    const { classifyRecovery } = await import('./lib/recovery.mjs');
    const { loadExecutorStatus } = await import('./lib/executor-status.mjs');
    const recovery = classifyRecovery(t, { availability: loadExecutorStatus() });
    console.log(JSON.stringify(inspectTask(t, { locksDir: LOCKS_DIR, recovery }), null, 2));
  } else if (cmd === 'list') {
    // PHASE 4 operator listing: every task with its recovery classification
    const { scanRecovery } = await import('./lib/recovery.mjs');
    const { loadExecutorStatus } = await import('./lib/executor-status.mjs');
    const rows = scanRecovery(TASKS_DIR, { locksDir: LOCKS_DIR, availability: loadExecutorStatus() });
    const filter = argValue('--status');
    const shown = filter ? rows.filter((r) => r.state === filter || r.recovery_class === filter) : rows;
    for (const r of shown) {
      console.log(`${(r.task_id ?? r.file ?? '?').padEnd(28)} ${(r.state ?? '?').padEnd(18)} rev=${String(r.revision ?? '?').padEnd(3)} class=${r.recovery_class}${r.lock ? ` lock=${r.lock.stale ? 'STALE' : 'held'}` : ''}`);
    }
    console.log(`total: ${shown.length}`);
  } else if (cmd === 'recover') {
    // PHASE 4 operator control. --scan ONLY reports; --task-id executes the
    // recovery after the user explicitly names the task. Never auto-recover.
    const { scanRecovery, classifyRecovery, recoverTask } = await import('./lib/recovery.mjs');
    const { loadExecutorStatus } = await import('./lib/executor-status.mjs');
    const availability = loadExecutorStatus();
    if (rest.includes('--scan')) {
      const rows = scanRecovery(TASKS_DIR, { locksDir: LOCKS_DIR, availability });
      const active = rows.filter((r) => r.recovery_class !== 'TERMINAL');
      for (const r of active) {
        console.log(JSON.stringify({
          task_id: r.task_id, status: r.state, recovery_class: r.recovery_class,
          recommended_action: r.recommended_action, revision: r.revision,
          state_version: r.state_version,
          author_session_ref: r.author_session_ref,
          candidate_id: r.candidate_id, latest_run: r.latest_run, last_error: r.last_error,
        }, null, 1));
      }
      console.log(`scan complete: ${active.length} non-terminal task(s), ${rows.length - active.length} terminal (reported as TERMINAL, never auto-rerun)`);
      process.exit(0);
    }
    const tid = argValue('--task-id');
    if (!tid) { console.error('usage: recover --scan | recover --task-id <id>'); process.exit(2); }
    const instance = `af-orch-${randomUUID().slice(0, 8)}`;
    const done = await recoverTask(tid, {
      adapters: ADAPTERS, tasksDir: TASKS_DIR, locksDir: LOCKS_DIR,
      availability, orchestratorInstanceId: instance,
      continueTaskFn: (id, o = {}) => continueTask(id, ADAPTERS, o),
      resumeGovernanceFn: (id, o = {}) => resumeGovernance(id, o),
      governanceBridge: null, targetCoordination: null,
    });
    console.log(`[orchestrator] recover result: ${JSON.stringify(done, null, 2)}`);
    process.exit(done?.outcome === 'RECOVERED' && done?.state === 'COMPLETED' ? 0 : (done?.outcome === 'TERMINAL' || done?.outcome === 'WAITING_EXTERNAL' ? 0 : 1));
  } else if (cmd === 'resume') {
    // Phase 2: re-query the Governance Plane for a WAITING_HUMAN task. The
    // Human Gate itself stays in vault-mcp / local-human-cli - the user does
    // the real gate, then this re-reads the truth. Never trusts local mirror.
    const resumeTaskId = argValue('--task-id');
    const done = await withTaskLock(resumeTaskId, () => resumeGovernance(resumeTaskId));
    console.log(`[orchestrator] resume result: ${done.state}${done.failure_reason ? ` (${done.failure_reason})` : ''}`);
    console.log(JSON.stringify({
      task_id: done.task_id,
      state: done.state,
      governance: done.governance ?? null,
      failure_reason: done.failure_reason ?? null,
    }, null, 2));
    process.exit(done.state === 'COMPLETED' ? 0 : 1);
  } else if (cmd === 'cancel') {
    // PHASE 4 Closure: cancellation with precise active-process termination.
    // 1) RUNNING-like: find the durable run handle(s) for this task, verify
    //    each PID's identity via /proc/<pid>/cmdline (CANCEL_TARGET_NOT_CONFIRMED
    //    on mismatch - never a blind kill), SIGTERM -> grace -> SIGKILL.
    // 2) WAITING_HUMAN / queued: Control Plane row only, no process to kill.
    // Governance audit trail (candidate/review/approval) is never touched.
    const tid = argValue('--task-id');
    const reason = argValue('--reason') ?? 'cancelled by operator';
    const graceMs = Number(argValue('--grace-ms') ?? 4000);
    const t0 = (() => {
      try {
        return loadTask(tid);
      } catch (err) {
        console.error(`[orchestrator] ${String(err?.message ?? err)}`);
        process.exit(2);
      }
    })();
    if (TERMINAL_STATES.has(t0.state)) {
      console.error(`[orchestrator] task=${tid} is already ${t0.state} (TASK_TERMINAL) - cancel refused`);
      process.exit(2);
    }
    const RUNS_HANDLE_DIR = join(ROOT, 'runtime', 'runs');
    // Identity hints for PID-reuse protection. Matched as SUBSTRINGS against
    // /proc/<pid>/cmdline: launchers are bash wrappers (claude-af/agy-af) that
    // `exec` into the real CLI, so the live cmdline shows claude-ccs/claude or
    // agy - the family substring is the durable identity, not the wrapper name.
    const launchers = { claude: 'claude', antigravity: 'agy', codex: 'codex' };
    const nowTs = new Date().toISOString();
    const termination = { requested: true, pid: null, signal: null, forced: false, observed_exit: null, already_exited: false, identity_confirmed: false };
    if (RUNNING_STATES.has(t0.state)) {
      let handles = [];
      try {
        for (const f of readdirSync(RUNS_HANDLE_DIR)) {
          if (!f.endsWith('.json')) continue;
          try {
            const h = JSON.parse(readFileSync(join(RUNS_HANDLE_DIR, f), 'utf8'));
            if (h.task_id === tid) handles.push(h);
          } catch { /* corrupt handle */ }
        }
      } catch { /* no runs dir */ }
      for (const h of handles) {
        if (!h.pid || !Number.isInteger(h.pid)) continue;
        // PID-reuse protection: confirm identity via /proc/<pid>/cmdline
        let cmdline = '';
        try { cmdline = readFileSync(`/proc/${h.pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { /* dead */ }
        const launcher = launchers[h.adapter_type] ?? h.adapter_type;
        if (!cmdline.includes(launcher)) {
          termination.identity_confirmed = false;
          termination.note = `CANCEL_TARGET_NOT_CONFIRMED: pid ${h.pid} cmdline does not contain ${launcher}`;
          continue;
        }
        termination.identity_confirmed = true;
        termination.pid = h.pid;
        // Mark the durable handle BEFORE signalling: the executor process's
        // execAsync reads this marker on exit so this SIGTERM/SIGKILL is
        // classified RUN_CANCELLED (never a crash -> FAILED overwrite of the
        // CANCELLED state recorded below).
        try {
          const hp = join(RUNS_HANDLE_DIR, `${h.run_id}.json`);
          const cur = JSON.parse(readFileSync(hp, 'utf8'));
          writeFileSync(hp, JSON.stringify({ ...cur, cancelled: true, cancel_requested_at: nowTs }, null, 2));
        } catch { /* handle gone - process already exited */ }
        let sig = 'SIGTERM';
        try { process.kill(h.pid, 'SIGTERM'); } catch { /* already dead */ }
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          let alive = true;
          try { process.kill(h.pid, 0); } catch { alive = false; }
          if (!alive) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        let stillAlive = false;
        try { process.kill(h.pid, 0); stillAlive = true; } catch { /* dead */ }
        if (stillAlive) {
          sig = 'SIGKILL';
          try { process.kill(h.pid, 'SIGKILL'); } catch { /* gone */ }
          termination.forced = true;
        }
        termination.signal = sig;
        termination.observed_exit = !stillAlive;
      }
      if (!handles.length) {
        termination.already_exited = true;
      }
    } else {
      termination.already_exited = true; // WAITING_HUMAN / non-running: no process to kill
    }
    // Re-read the task right before writing the terminal state (race vs a
    // natural completion): never overwrite a terminal state with CANCELLED.
    const t = loadTask(tid);
    const nowTs2 = new Date().toISOString();
    t.cancel_requested_at = t0.cancel_requested_at ?? t0.updated_at ?? nowTs2;
    t.cancel_reason = reason;
    t.cancelled_by = 'operator';
    const lastRun = t.runs[t.runs.length - 1] ?? null;
    t.active_run_id = lastRun && !TERMINAL_STATES.has(t.state) ? lastRun.executor_run_id : null;
    t.termination = { ...termination };
    if (TERMINAL_STATES.has(t.state)) {
      console.log(`[orchestrator] task=${tid} already ${t.state} - cancel recorded but terminal state kept`);
      console.log(JSON.stringify({ task_id: tid, state: t.state, termination: t.termination }, null, 2));
      process.exit(0);
    }
    t.state = 'CANCELLED';
    t.cancelled_at = nowTs;
    saveTask(t);
    console.log(`[orchestrator] task=${tid} state=CANCELLED (governance audit trail untouched)`);
    console.log(JSON.stringify({ task_id: tid, termination: t.termination }, null, 2));
  } else if (cmd === 'executor') {
    const { getExecutorOperationsStatus, formatExecutorStatus, listCircuitBreakers } = await import('./lib/executor-ops.mjs');
    const sub = rest[0];
    if (sub === 'status') {
      const target = rest[1] && !rest[1].startsWith('-') ? rest[1] : argValue('--executor');
      if (target) {
        console.log(formatExecutorStatus(getExecutorOperationsStatus(target)));
      } else {
        const list = listCircuitBreakers();
        console.log(list.map((item) => formatExecutorStatus(getExecutorOperationsStatus(item.id))).join('\n\n---\n\n'));
      }
      process.exit(0);
    } else if (sub === 'profile') {
      const { getExecutorEffectiveProfile } = await import('./lib/executor-status.mjs');
      const target = rest[1] && !rest[1].startsWith('-') ? rest[1] : argValue('--executor');
      const targets = target ? [target] : ['codex', 'cline', 'claude'];
      for (const t of targets) {
        const p = getExecutorEffectiveProfile(t);
        console.log(`Executor: ${p.executor.toUpperCase()}`);
        if (p.configured === false) {
          console.log(`  Status:  未配置 (UNCONFIGURED)`);
          console.log(`  Note:    ${p.note}\n`);
          continue;
        }
        console.log(`  Model:   ${p.model} (source: ${p.model_source})`);
        console.log(`  Effort:  ${p.effort} (source: ${p.effort_source})`);
        console.log(`  MCP:     ${p.mcp_unattended ? 'unattended PASS' : 'none'}`);
        console.log(`  Sandbox: ${p.sandbox}\n`);
      }
      process.exit(0);
    } else {
      console.error('usage: orchestrator.mjs executor status [executor] | executor profile [executor]');
      process.exit(2);
    }
  } else if (cmd === 'circuit') {
    const { listCircuitBreakers, formatCircuitList, resetCircuitBreaker } = await import('./lib/executor-ops.mjs');
    const sub = rest[0];
    if (sub === 'list') {
      console.log(formatCircuitList(listCircuitBreakers()));
      process.exit(0);
    } else if (sub === 'reset') {
      const target = rest[1] && !rest[1].startsWith('-') ? rest[1] : argValue('--executor');
      const reason = argValue('--reason');
      const resetBy = argValue('--reset-by') || process.env.USER || 'operator';
      if (!target) { console.error('error: executor is required: orchestrator.mjs circuit reset <executor> --reason "<reason>"'); process.exit(1); }
      if (!reason || !reason.trim()) { console.error('error: --reason is required for manual circuit reset'); process.exit(1); }
      const res = resetCircuitBreaker(target, { reason, reset_by: resetBy });
      console.log(`Circuit reset successful:`);
      console.log(`executor: ${res.executorType}`);
      console.log(`state: ${res.state}`);
      console.log(`reset_by: ${res.reset_by}`);
      console.log(`reset_time: ${res.reset_time}`);
      console.log(`reason: ${res.reason}`);
      process.exit(0);
    } else {
      console.error('usage: orchestrator.mjs circuit list | circuit reset <executor> --reason "<reason>"');
      process.exit(2);
    }
  } else {
    console.error('usage: orchestrator.mjs run --task-file <json> | status|inspect|resume|cancel --task-id <id> | list [--status <f>] | recover --scan | recover --task-id <id> | executor status [executor] | circuit list | circuit reset <executor> --reason "<reason>"');
    process.exit(2);
  }
}
