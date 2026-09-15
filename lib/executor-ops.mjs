// executor-ops.mjs - PHASE 5-B Executor Operations Layer
//
// Responsibilities:
//   1. View executor runtime status (merging capability truth, availability truth, and runtime safety state)
//   2. Manage circuit breaker manually (list and manual reset requiring --reason)
//   3. Read and provide audit evidence
//
// Boundaries (STRICT):
//   - DOES NOT create new truth sources (reads executor.json, executor-status.mjs, executor-safety-state.json).
//   - DOES NOT schedule, execute, or manage governance.
//   - DOES NOT automatically reset circuits.
//   - ROLE != PLATFORM preserved.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExecutorStatus, EXECUTORS_DIR } from './executor-status.mjs';
import { runtimeGuard as defaultRuntimeGuard } from './executor-runtime-guard.mjs';
import { ADAPTERS } from './adapters.mjs';
import { classifyExecutionError } from './executor-error-classifier.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EVENTS_LOG_FILE = join(ROOT_DIR, 'runtime', 'executor-runtime-events.jsonl');

const KNOWN_EXECUTORS = ['antigravity', 'claude', 'codex'];

export function resolveExecutorId(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (n === 'agy') return 'antigravity';
  return n;
}

export function displayExecutorId(id) {
  if (id === 'antigravity') return 'agy';
  return id;
}

export function getExecutorOperationsStatus(executorInput, { executorsDir = EXECUTORS_DIR, runtimeGuard = defaultRuntimeGuard } = {}) {
  const id = resolveExecutorId(executorInput);
  if (!id) throw new Error('executor name is required');

  const statusMap = loadExecutorStatus(executorsDir);
  const audit = statusMap.get(id);

  const capability = audit?.capability_status ?? 'UNKNOWN';
  const availability = audit?.reason ?? audit?.availability_status ?? 'UNKNOWN';

  runtimeGuard.projectCooldown?.(id);
  const c = runtimeGuard.getCircuitState(id);
  const runtime = c.state;
  const circuit = c.state.startsWith('OPEN') ? 'OPEN' : c.state;
  const last_failure = c.category || c.reason || 'NONE';
  const reason = c.reason || c.category || audit?.reason || audit?.blocker || 'NONE';
  const reset_required = c.state === 'OPEN_MANUAL_RESET';

  return {
    executor: id,
    capability,
    availability,
    runtime,
    circuit,
    last_failure,
    reason,
    reset_required,
    last_reset: c.last_reset ?? null,
  };
}

export function formatExecutorStatus(s) {
  return [
    'executor:',
    s.executor,
    '',
    'capability:',
    s.capability,
    '',
    'availability:',
    s.availability,
    '',
    'runtime:',
    s.runtime,
    '',
    'reason:',
    s.reason || s.last_failure || 'NONE',
    '',
    'circuit:',
    s.circuit,
    '',
    'last_failure:',
    s.last_failure,
    '',
    'reset_required:',
    String(s.reset_required),
  ].join('\n');
}

export function listCircuitBreakers({ runtimeGuard = defaultRuntimeGuard, executorsDir = EXECUTORS_DIR, now = new Date().toISOString() } = {}) {
  const statusMap = loadExecutorStatus(executorsDir);
  const ids = Array.from(new Set([...KNOWN_EXECUTORS, ...statusMap.keys()]));

  const results = [];
  for (const id of ids) {
    const c = runtimeGuard.getCircuitState(id);
    let state = c.state;
    // 冷却状态投影: 如果 OPEN_COOLDOWN 且 now >= cooldown_until, 显示 HALF_OPEN_PENDING
    // 允许人工观察, 禁止自动transition
    if (c.state === 'OPEN_COOLDOWN' && c.cooldown_until && now >= c.cooldown_until) {
      state = 'HALF_OPEN_PENDING';
    }
    results.push({
      id,
      displayId: displayExecutorId(id),
      state,
      rawState: c.state,
      category: c.category || null,
      reason: c.reason || null,
      opened_at: c.opened_at || null,
      cooldown_until: c.cooldown_until || null,
      last_reset: c.last_reset || null,
    });
  }
  return results;
}

export function formatCircuitList(list) {
  return list.map((item) => {
    const lines = [
      `${item.displayId}:`,
      `${item.state}`,
      `  opened_at: ${item.opened_at || 'null'}`,
      `  reason: ${item.reason || item.category || 'null'}`,
      `  cooldown_until: ${item.cooldown_until || 'null'}`,
      `  last_reset: ${item.last_reset ? (typeof item.last_reset === 'object' ? JSON.stringify(item.last_reset) : String(item.last_reset)) : 'null'}`,
    ];
    return lines.join('\n');
  }).join('\n\n');
}

export function resetCircuitBreaker(executorInput, {
  reason,
  reset_by = 'operator',
  runtimeGuard = defaultRuntimeGuard,
} = {}) {
  if (!executorInput) {
    throw new Error('executor is required for manual circuit reset');
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('--reason is required for manual circuit reset');
  }

  const id = resolveExecutorId(executorInput);
  const res = runtimeGuard.resetCircuit(id, {
    reset_by: String(reset_by).trim() || 'operator',
    reason: String(reason).trim(),
  });

  return res;
}

export function readRuntimeAuditEvents({ eventsLogFile = DEFAULT_EVENTS_LOG_FILE } = {}) {
  if (!existsSync(eventsLogFile)) return [];
  try {
    const lines = readFileSync(eventsLogFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function executeRecoveryProbe(executorInput, {
  adapters = ADAPTERS,
  runtimeGuard = defaultRuntimeGuard,
  timeoutMs = 15000,
  sandboxDir = null,
  prompt = 'AGENT_FOUNDRY_PROBE_PING',
} = {}) {
  const id = resolveExecutorId(executorInput);
  if (!id) throw new Error('executor name is required for recovery probe');

  const adapter = adapters[id];
  if (!adapter) throw new Error(`unknown executor: ${id}`);

  // 1. Guard check & transition: OPEN_MANUAL_RESET -> PROBING
  // startProbe throws if CLOSED or already PROBING
  runtimeGuard.startProbe(id);

  // 2. Create isolated hermetic sandbox directory
  let tempDirCreated = false;
  let dir = sandboxDir;
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), `af-recovery-probe-${id}-${randomUUID().slice(0, 8)}-`));
    tempDirCreated = true;
  }

  const probeRunId = `PROBE-${randomUUID().slice(0, 8)}`;
  const probeCapsule = {
    task_id: `PROBE-TASK-${randomUUID().slice(0, 8)}`,
    runId: probeRunId,
    purpose: 'recovery_probe',
    assigned_role: 'verifier',
    prompt,
    cwd: dir,
    timeout_ms: timeoutMs,
  };

  let runResult;
  try {
    runResult = await adapter.run(probeCapsule);
  } catch (err) {
    runResult = {
      executor_run_id: probeRunId,
      executor_type: id,
      assigned_role: 'verifier',
      status: 'failed',
      exit_code: -1,
      error: String(err?.message ?? err),
      structured_result: null,
    };
  } finally {
    if (tempDirCreated && existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  // 3. Classify execution result
  const classification = runResult.error_classification || classifyExecutionError(id, {
    exit_code: runResult.exit_code,
    stderr: runResult.error || '',
    stdout: typeof runResult.structured_result?.result === 'string' ? runResult.structured_result.result : '',
  });

  // 4. Update Guard state based on classification
  if (runResult.status === 'completed' && classification.category === 'SUCCESS') {
    const evidence_id = `PEVT-${randomUUID().slice(0, 8)}`;
    runtimeGuard.recordProbeSuccess(id, {
      evidence_id,
      run_id: runResult.executor_run_id,
      classification,
      timestamp: runResult.finished_at || new Date().toISOString(),
    });
    return {
      success: true,
      executor: id,
      evidence_id,
      state: 'HALF_OPEN',
      run_id: runResult.executor_run_id,
      exit_code: runResult.exit_code,
      classification,
    };
  } else {
    runtimeGuard.recordProbeFailure(id, {
      category: classification.category,
      reason: classification.reason || runResult.error,
      run_id: runResult.executor_run_id,
      timestamp: runResult.finished_at || new Date().toISOString(),
    });
    return {
      success: false,
      executor: id,
      evidence_id: null,
      state: 'OPEN_MANUAL_RESET',
      run_id: runResult.executor_run_id,
      exit_code: runResult.exit_code,
      category: classification.category,
      reason: classification.reason || runResult.error,
    };
  }
}

export function admitRecoveredExecutor(executorInput, {
  evidence_id,
  reason,
  admitted_by = 'operator',
  runtimeGuard = defaultRuntimeGuard,
} = {}) {
  const id = resolveExecutorId(executorInput);
  if (!id) throw new Error('executor name is required for recovery admission');

  return runtimeGuard.admitExecutor(id, {
    evidence_id,
    reason,
    admitted_by,
  });
}

export function formatRecoveryProbeResult(res) {
  if (res.success) {
    return [
      'Recovery Probe: SUCCESS',
      `executor:       ${res.executor}`,
      `exit_code:      ${res.exit_code}`,
      `evidence_id:    ${res.evidence_id}`,
      `state:          ${res.state}`,
      '',
      'Next step: Review evidence and admit:',
      `  af-admin executor recovery admit ${res.executor} --evidence ${res.evidence_id} --reason "<reason>"`,
    ].join('\n');
  } else {
    return [
      'Recovery Probe: FAILED',
      `executor:       ${res.executor}`,
      `category:       ${res.category}`,
      `reason:         ${res.reason}`,
      `state:          ${res.state}`,
      '',
      'Status: Executor remains locked in OPEN_MANUAL_RESET.',
    ].join('\n');
  }
}

export function formatAdmissionResult(res) {
  return [
    'Recovery Admission: APPROVED',
    `executor:       ${res.executorType}`,
    `state:          ${res.state}`,
    `evidence_id:    ${res.evidence_id}`,
    `admitted_by:    ${res.admitted_by}`,
    `reset_time:     ${res.reset_time}`,
    `reason:         ${res.reason}`,
  ].join('\n');
}

// ---------------------------------------------------------------- Tasks Prune
const PRUNABLE_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function pruneTasks({ tasksDir = join(ROOT_DIR, 'tasks'), confirm = false } = {}) {
  if (!existsSync(tasksDir)) {
    return { dry_run: !confirm, candidate_ids: [], removed_ids: [], protected_ids: [], candidates: [] };
  }

  const files = readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
  const candidates = [];
  const protectedTasks = [];

  for (const file of files) {
    try {
      const content = JSON.parse(readFileSync(join(tasksDir, file), 'utf8'));
      const id = content.task_id || file.replace(/\.json$/, '');
      const state = content.state;
      if (PRUNABLE_STATES.has(state)) {
        candidates.push({ task_id: id, state, file });
      } else {
        protectedTasks.push({ task_id: id, state, file });
      }
    } catch {
      // Unparseable files are protected, do not delete
      protectedTasks.push({ task_id: file.replace(/\.json$/, ''), state: 'UNPARSEABLE', file });
    }
  }

  const candidateIds = candidates.map((c) => c.task_id);
  const protectedIds = protectedTasks.map((p) => p.task_id);

  if (!confirm) {
    return {
      dry_run: true,
      candidate_ids: candidateIds,
      removed_ids: [],
      protected_ids: protectedIds,
      candidates,
    };
  }

  const removedIds = [];
  for (const c of candidates) {
    try {
      unlinkSync(join(tasksDir, c.file));
      removedIds.push(c.task_id);
    } catch { /* best effort */ }
  }

  return {
    dry_run: false,
    candidate_ids: candidateIds,
    removed_ids: removedIds,
    protected_ids: protectedIds,
    candidates,
  };
}

export function formatTasksPruneResult(res) {
  if (res.dry_run) {
    if (res.candidate_ids.length === 0) {
      return 'No tasks to prune (no terminal tasks found).';
    }
    const lines = [
      'would remove:',
      ...res.candidate_ids.map((id) => `  ${id}`),
      '',
      `Total: ${res.candidate_ids.length} task(s) would be removed (dry-run).`,
      'To execute removal, run: af-admin tasks prune --confirm',
    ];
    return lines.join('\n');
  } else {
    if (res.removed_ids.length === 0) {
      return 'No tasks were removed.';
    }
    const lines = [
      'removed:',
      ...res.removed_ids.map((id) => `  ${id}`),
      '',
      `Total: ${res.removed_ids.length} task(s) removed.`,
    ];
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------- Logs Rotation
export function rotateLogs({
  eventsLogFile = DEFAULT_EVENTS_LOG_FILE,
  archiveDir = join(dirname(eventsLogFile), 'archive'),
  days = 7,
  now = new Date(),
} = {}) {
  if (!existsSync(eventsLogFile)) {
    return { rotated: false, archived_count: 0, retained_count: 0, archive_file: null };
  }

  const rawContent = readFileSync(eventsLogFile, 'utf8');
  if (!rawContent.trim()) {
    return { rotated: false, archived_count: 0, retained_count: 0, archive_file: null };
  }

  const lines = rawContent.split('\n');
  const nowDate = now instanceof Date ? now : new Date(now);
  const cutoffTime = nowDate.getTime() - Number(days) * 24 * 60 * 60 * 1000;

  const toArchive = [];
  const toRetain = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let eventTime = null;
    try {
      const parsed = JSON.parse(line);
      const ts = parsed.timestamp || parsed.at || parsed.time;
      if (ts) {
        eventTime = new Date(ts).getTime();
      }
    } catch {
      // Unparseable line, retain in active log
      toRetain.push(line);
      continue;
    }

    if (eventTime !== null && !isNaN(eventTime) && eventTime < cutoffTime) {
      toArchive.push(line);
    } else {
      toRetain.push(line);
    }
  }

  if (toArchive.length === 0) {
    return { rotated: false, archived_count: 0, retained_count: toRetain.length, archive_file: null };
  }

  mkdirSync(archiveDir, { recursive: true });
  const archiveTs = nowDate.toISOString().replace(/[:.]/g, '-');
  const archiveFile = join(archiveDir, `executor-runtime-events-${archiveTs}.jsonl`);

  // Write exact original line strings without modification
  writeFileSync(archiveFile, toArchive.join('\n') + '\n', 'utf8');

  // Atomically update active log with retained events
  const tempLog = `${eventsLogFile}.tmp.${randomUUID().slice(0, 8)}`;
  writeFileSync(tempLog, toRetain.length > 0 ? toRetain.join('\n') + '\n' : '', 'utf8');
  renameSync(tempLog, eventsLogFile);

  return {
    rotated: true,
    archived_count: toArchive.length,
    retained_count: toRetain.length,
    archive_file: archiveFile,
  };
}

export function formatLogRotationResult(res) {
  if (!res.rotated) {
    return `Log rotation: no events older than retention threshold. Retained ${res.retained_count} event(s).`;
  }
  return [
    'Log rotation: SUCCESS',
    `archived_events: ${res.archived_count}`,
    `retained_events: ${res.retained_count}`,
    `archive_file:    ${res.archive_file}`,
  ].join('\n');
}
