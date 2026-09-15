// executor-runtime-guard.mjs - PHASE 5-A Executor Runtime Safety Guard
//
// Responsibilities:
//   1. Concurrency limit per executor type (max_parallel)
//   2. Launch pacing (min_interval_ms)
//   3. Circuit Breaker (CLOSED / OPEN_MANUAL_RESET / OPEN_COOLDOWN / HALF_OPEN)
//   4. Persistence of circuit state to runtime/executor-safety-state.json
//
// Boundaries:
//   - DOES NOT manage tasks, roles, or governance.
//   - Reads policy from runtime/executor-safety-policy.json (not capability registry).
//   - Persists recovery state to runtime/executor-safety-state.json.

import { readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './store.mjs';
import { EXECUTORS_DIR } from './config.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PROFILES_FILE = join(ROOT_DIR, 'config', 'executor-safety-profiles.json');
const DEFAULT_POLICY_FILE = existsSync(CONFIG_PROFILES_FILE) ? CONFIG_PROFILES_FILE : join(ROOT_DIR, 'runtime', 'executor-safety-policy.json');
// Runtime safety state is per-instance data. The env overrides let tests drive
// the default guard against a temporary state/log instead of the checkout.
const DEFAULT_STATE_FILE = process.env.AF_SAFETY_STATE_FILE || join(ROOT_DIR, 'runtime', 'executor-safety-state.json');
const DEFAULT_EVENTS_LOG_FILE = process.env.AF_RUNTIME_EVENTS_LOG || join(ROOT_DIR, 'runtime', 'executor-runtime-events.jsonl');

const DEFAULT_POLICIES = {
  antigravity: { max_parallel: 1, min_interval_ms: 5000, cooldown_ms: 3600000 },
  claude: { max_parallel: 2, min_interval_ms: 1000, cooldown_ms: 60000 },
  codex: { max_parallel: 1, min_interval_ms: 2000, cooldown_ms: 60000 },
  'vertex-gemini': { max_parallel: 4, min_interval_ms: 200, cooldown_ms: 60000 },
};

export class ExecutorRuntimeGuard {
  constructor({
    policyFile = DEFAULT_POLICY_FILE,
    stateFile = DEFAULT_STATE_FILE,
    eventsLogFile = DEFAULT_EVENTS_LOG_FILE,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.policyFile = policyFile;
    this.stateFile = stateFile;
    this.eventsLogFile = eventsLogFile;
    this.now = now;
    this.sleep = sleep;

    this.activeProcesses = new Map(); // executor -> count
    this.lastLaunchTimes = new Map(); // executor -> timestamp ms
    this.waitQueues = new Map();      // executor -> Array<resolveFn>
    this.circuits = new Map();        // executor -> { state, category, reason, opened_at, cooldown_until, last_reset }

    this.#loadPolicy();
    this.#loadState();
  }

  appendAuditEvent(event) {
    if (!this.eventsLogFile) return;
    try {
      const FORBIDDEN = new Set(['prompt', 'response', 'token', 'credential', 'password', 'key', 'secret', 'auth']);
      const sanitized = {};
      for (const [k, v] of Object.entries(event)) {
        if (!FORBIDDEN.has(k.toLowerCase())) {
          sanitized[k] = v;
        }
      }
      mkdirSync(dirname(this.eventsLogFile), { recursive: true });
      appendFileSync(this.eventsLogFile, JSON.stringify(sanitized) + '\n', 'utf8');
    } catch { /* best effort */ }
  }

  recordLaunchBlocked(executorType, reason) {
    const c = this.getCircuitState(executorType);
    this.appendAuditEvent({
      executor: executorType,
      event: 'LAUNCH_BLOCKED',
      circuit_state: c.state,
      reason: reason || c.reason || 'blocked',
      timestamp: new Date(this.now()).toISOString(),
    });
  }

  #loadPolicy() {
    this.policies = { ...DEFAULT_POLICIES };
    try {
      if (existsSync(this.policyFile)) {
        const parsed = JSON.parse(readFileSync(this.policyFile, 'utf8'));
        this.policies = { ...this.policies, ...parsed };
      }
    } catch { /* use defaults */ }
  }

  #loadState() {
    if (!existsSync(this.stateFile)) return; // first start: everything CLOSED

    let data;
    try {
      data = JSON.parse(readFileSync(this.stateFile, 'utf8'));
    } catch {
      // Unreadable safety state must never mean "nothing is broken". A corrupt
      // file used to yield an empty circuit map, which silently reopened every
      // breaker (canExecute -> true) - the opposite of fail-closed. Quarantine
      // the evidence and lock every known executor until an operator admits it
      // through the gated recovery flow.
      try {
        renameSync(this.stateFile, `${this.stateFile}.corrupt-${Date.now()}`);
      } catch { /* best effort */ }
      for (const id of this.#knownExecutorIds()) {
        this.circuits.set(id, {
          state: 'OPEN_MANUAL_RESET',
          category: 'STATE_CORRUPTION',
          reason: 'circuit state file corrupt - manual probe/admit required',
          opened_at: new Date(this.now()).toISOString(),
          cooldown_until: null,
          last_reset: null,
        });
      }
      this.#saveState();
      this.appendAuditEvent({
        event: 'STATE_CORRUPTION',
        reason: 'circuit state file unreadable - all executors failed closed',
        timestamp: new Date(this.now()).toISOString(),
      });
      return;
    }

    for (const [id, s] of Object.entries(data ?? {})) {
      this.circuits.set(id, {
        state: s.state || 'CLOSED',
        category: s.category || null,
        reason: s.reason || null,
        opened_at: s.opened_at || null,
        cooldown_until: s.cooldown_until || null,
        probe_evidence_id: s.probe_evidence_id || null,
        probe_started_at: s.probe_started_at || null,
        probe_verified_at: s.probe_verified_at || null,
        last_reset: s.last_reset || null,
      });
    }
  }

  // The capability registry is the single source for which executors exist;
  // the core five are always included so a missing registry cannot leave an
  // executor unguarded.
  #knownExecutorIds() {
    const ids = new Set(['antigravity', 'claude', 'codex', 'vertex-gemini', 'cline']);
    try {
      for (const f of readdirSync(EXECUTORS_DIR)) {
        if (f.endsWith('.json') && f !== 'contract.json') ids.add(f.replace(/\.json$/, ''));
      }
    } catch { /* registry unavailable: the core five still apply */ }
    return [...ids];
  }

  #saveState() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const obj = {};
      for (const [id, c] of this.circuits.entries()) {
        obj[id] = {
          state: c.state,
          category: c.category || null,
          reason: c.reason,
          opened_at: c.opened_at,
          cooldown_until: c.cooldown_until,
          ...(c.probe_evidence_id ? { probe_evidence_id: c.probe_evidence_id } : {}),
          ...(c.probe_started_at ? { probe_started_at: c.probe_started_at } : {}),
          ...(c.probe_verified_at ? { probe_verified_at: c.probe_verified_at } : {}),
          ...(c.last_reset ? { last_reset: c.last_reset } : {}),
        };
      }
      writeJsonAtomic(this.stateFile, obj);
    } catch { /* best effort */ }
  }

  getPolicy(executorType) {
    return this.policies[executorType] || { max_parallel: 1, min_interval_ms: 1000, cooldown_ms: 60000 };
  }

  // Pure read: a query must never mutate or persist state.
  getCircuitState(executorType) {
    const c = this.circuits.get(executorType);
    if (!c) return { state: 'CLOSED', reason: null, opened_at: null, cooldown_until: null, last_reset: null };
    return { ...c };
  }

  // Explicit projection of an expired cooldown to HALF_OPEN. Callers that are
  // about to act on the circuit call this so the transition is persisted once,
  // instead of every read writing to disk.
  #projectCooldown(executorType) {
    const c = this.circuits.get(executorType);
    if (c && c.state === 'OPEN_COOLDOWN' && c.cooldown_until && this.now() >= c.cooldown_until) {
      c.state = 'HALF_OPEN';
      this.#saveState();
      this.appendAuditEvent({
        executor: executorType,
        event: 'COOLDOWN_ELAPSED',
        timestamp: new Date(this.now()).toISOString(),
      });
    }
  }

  // Explicit projection of an elapsed cooldown for callers that are about to
  // display or act on the circuit (operator views): the single transition is
  // persisted once instead of every read writing to disk.
  projectCooldown(executorType) {
    this.#projectCooldown(executorType);
  }

  canExecute(executorType, purpose = 'production') {
    // An elapsed cooldown is projected to HALF_OPEN here, at the point of use,
    // instead of on every read.
    this.#projectCooldown(executorType);
    const c = this.getCircuitState(executorType);
    if (purpose === 'recovery_probe') {
      return c.state === 'PROBING';
    }
    if (c.state === 'OPEN_MANUAL_RESET' || c.state === 'OPEN_COOLDOWN' || c.state === 'PROBING' || c.state === 'HALF_OPEN') {
      return false;
    }
    return true; // CLOSED
  }

  async acquireSlot(executorType, purpose = 'production') {
    if (!this.canExecute(executorType, purpose)) {
      const c = this.getCircuitState(executorType);
      this.recordLaunchBlocked(executorType, c.reason);
      const err = new Error(`EXECUTOR_CIRCUIT_OPEN: ${executorType} circuit is ${c.state} (${c.reason ?? 'blocked'})`);
      err.code = 'CIRCUIT_OPEN';
      throw err;
    }

    const policy = this.getPolicy(executorType);
    const maxParallel = policy.max_parallel ?? 1;

    // 1. Concurrency limit (wait until an active slot is freed)
    while ((this.activeProcesses.get(executorType) || 0) >= maxParallel) {
      await new Promise((res) => {
        if (!this.waitQueues.has(executorType)) this.waitQueues.set(executorType, []);
        this.waitQueues.get(executorType).push(res);
      });
      // Re-check circuit state after waking up
      if (!this.canExecute(executorType, purpose)) {
        const c = this.getCircuitState(executorType);
        this.recordLaunchBlocked(executorType, c.reason);
        const err = new Error(`EXECUTOR_CIRCUIT_OPEN: ${executorType} circuit is ${c.state} (${c.reason ?? 'blocked'})`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }

    // 2. Atomically reserve slot before any async delay (pacing sleep)
    const currentActive = this.activeProcesses.get(executorType) || 0;
    this.activeProcesses.set(executorType, currentActive + 1);

    // 3. Launch pacing (min_interval_ms)
    try {
      const minInterval = policy.min_interval_ms ?? 0;
      const lastLaunch = this.lastLaunchTimes.get(executorType) || 0;
      const elapsed = this.now() - lastLaunch;
      if (elapsed < minInterval) {
        await this.sleep(minInterval - elapsed);
      }
      this.lastLaunchTimes.set(executorType, this.now());
    } catch (err) {
      this.releaseSlot(executorType);
      throw err;
    }
  }

  releaseSlot(executorType) {
    const currentActive = this.activeProcesses.get(executorType) || 0;
    if (currentActive > 0) {
      this.activeProcesses.set(executorType, currentActive - 1);
    }
    // Wake up one waiting slot acquirer if any
    const queue = this.waitQueues.get(executorType);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      next();
    }
  }

  recordResult(executorType, classification) {
    if (!classification) return;
    const c = this.getCircuitState(executorType);

    if (classification.safety_action === 'OPEN_MANUAL_RESET') {
      const openedAt = new Date(this.now()).toISOString();
      this.circuits.set(executorType, {
        state: 'OPEN_MANUAL_RESET',
        category: classification.category || 'ACCOUNT_POLICY',
        reason: classification.reason,
        opened_at: openedAt,
        cooldown_until: null,
        last_reset: c.last_reset || null,
      });
      this.#saveState();
      this.appendAuditEvent({
        executor: executorType,
        event: 'CIRCUIT_OPEN',
        category: classification.category || 'ACCOUNT_POLICY',
        reason: classification.reason,
        timestamp: openedAt,
      });
      return;
    }

    if (classification.safety_action === 'COOLDOWN') {
      const policy = this.getPolicy(executorType);
      const cooldownMs = policy.cooldown_ms || 60000;
      const openedAt = new Date(this.now()).toISOString();
      this.circuits.set(executorType, {
        state: 'OPEN_COOLDOWN',
        category: classification.category || 'RATE_LIMIT',
        reason: classification.reason,
        opened_at: openedAt,
        cooldown_until: this.now() + cooldownMs,
        last_reset: c.last_reset || null,
      });
      this.#saveState();
      this.appendAuditEvent({
        executor: executorType,
        event: 'CIRCUIT_OPEN',
        category: classification.category || 'RATE_LIMIT',
        reason: classification.reason,
        timestamp: openedAt,
      });
      return;
    }

    if (classification.category === 'SUCCESS') {
      if (c.state === 'HALF_OPEN') {
        this.circuits.set(executorType, {
          state: 'CLOSED',
          category: null,
          reason: null,
          opened_at: null,
          cooldown_until: null,
          last_reset: c.last_reset || null,
        });
        this.#saveState();
      }
    }
  }

  resetCircuit(executorType, { reset_by = 'operator', reason = 'manual reset' } = {}) {
    const resetTime = new Date(this.now()).toISOString();
    const lastReset = {
      reset_by,
      reason,
      reset_time: resetTime,
    };
    this.circuits.set(executorType, {
      state: 'CLOSED',
      category: null,
      reason: null,
      opened_at: null,
      cooldown_until: null,
      last_reset: lastReset,
    });
    this.#saveState();
    this.appendAuditEvent({
      executor: executorType,
      event: 'CIRCUIT_RESET',
      reset_by,
      reason,
      timestamp: resetTime,
    });
    return {
      executorType,
      state: 'CLOSED',
      reset_by,
      reason,
      reset_time: resetTime,
      last_reset: lastReset,
    };
  }

  startProbe(executorType) {
    const c = this.getCircuitState(executorType);
    if (c.state === 'CLOSED') {
      const err = new Error(`PROBE_REJECTED: ${executorType} circuit is already healthy/CLOSED`);
      err.code = 'PROBE_REJECTED';
      throw err;
    }
    if (c.state === 'PROBING') {
      const err = new Error(`PROBE_ALREADY_IN_PROGRESS: ${executorType} probe is already active`);
      err.code = 'PROBE_ALREADY_IN_PROGRESS';
      throw err;
    }
    const probeStartedAt = new Date(this.now()).toISOString();
    this.circuits.set(executorType, {
      state: 'PROBING',
      category: c.category || null,
      reason: c.reason || null,
      opened_at: c.opened_at || probeStartedAt,
      cooldown_until: null,
      probe_started_at: probeStartedAt,
      probe_evidence_id: null,
      last_reset: c.last_reset || null,
    });
    this.#saveState();
    this.appendAuditEvent({
      executor: executorType,
      event: 'PROBE_STARTED',
      timestamp: probeStartedAt,
    });
    return {
      executorType,
      state: 'PROBING',
      probe_started_at: probeStartedAt,
    };
  }

  recordProbeSuccess(executorType, { evidence_id, run_id, classification, timestamp } = {}) {
    const c = this.getCircuitState(executorType);
    if (c.state !== 'PROBING') {
      const err = new Error(`INVALID_PROBE_STATE: expected PROBING, got ${c.state}`);
      err.code = 'INVALID_PROBE_STATE';
      throw err;
    }
    const verifiedAt = timestamp || new Date(this.now()).toISOString();
    this.circuits.set(executorType, {
      state: 'HALF_OPEN',
      category: null,
      reason: null,
      opened_at: c.opened_at,
      cooldown_until: null,
      probe_started_at: c.probe_started_at,
      probe_evidence_id: evidence_id,
      probe_verified_at: verifiedAt,
      last_reset: c.last_reset || null,
    });
    this.#saveState();
    this.appendAuditEvent({
      executor: executorType,
      event: 'PROBE_VERIFIED',
      evidence_id,
      run_id: run_id || null,
      timestamp: verifiedAt,
    });
    return {
      executorType,
      state: 'HALF_OPEN',
      evidence_id,
      probe_verified_at: verifiedAt,
    };
  }

  recordProbeFailure(executorType, { category, reason, run_id, timestamp } = {}) {
    const c = this.getCircuitState(executorType);
    const failTime = timestamp || new Date(this.now()).toISOString();
    this.circuits.set(executorType, {
      state: 'OPEN_MANUAL_RESET',
      category: category || 'ACCOUNT_POLICY',
      reason: reason || 'recovery probe verification failed',
      opened_at: c.opened_at || failTime,
      cooldown_until: null,
      probe_evidence_id: null,
      probe_started_at: null,
      last_reset: c.last_reset || null,
    });
    this.#saveState();
    this.appendAuditEvent({
      executor: executorType,
      event: 'PROBE_FAILED',
      category: category || 'ACCOUNT_POLICY',
      reason: reason || 'recovery probe verification failed',
      run_id: run_id || null,
      timestamp: failTime,
    });
    return {
      executorType,
      state: 'OPEN_MANUAL_RESET',
      reason: reason || 'recovery probe verification failed',
      category: category || 'ACCOUNT_POLICY',
    };
  }

  admitExecutor(executorType, { evidence_id, reason, admitted_by = 'operator' } = {}) {
    if (!reason || !reason.trim()) {
      const err = new Error('ADMISSION_REJECTED: reason is required for executor recovery admission');
      err.code = 'REASON_REQUIRED';
      throw err;
    }
    if (!evidence_id || !evidence_id.trim()) {
      const err = new Error('ADMISSION_REJECTED: evidence_id is required for executor recovery admission');
      err.code = 'EVIDENCE_REQUIRED';
      throw err;
    }
    const c = this.getCircuitState(executorType);
    if (c.state !== 'HALF_OPEN') {
      const err = new Error(`ADMISSION_REJECTED: executor is ${c.state}, not HALF_OPEN (must complete probe first)`);
      err.code = 'INVALID_ADMISSION_STATE';
      throw err;
    }
    if (c.probe_evidence_id !== evidence_id) {
      const err = new Error(`ADMISSION_REJECTED: evidence_id mismatch (expected ${c.probe_evidence_id}, got ${evidence_id})`);
      err.code = 'EVIDENCE_MISMATCH';
      throw err;
    }
    const admitTime = new Date(this.now()).toISOString();
    const lastReset = {
      reset_by: admitted_by,
      reason,
      evidence_id,
      reset_time: admitTime,
    };
    this.circuits.set(executorType, {
      state: 'CLOSED',
      category: null,
      reason: null,
      opened_at: null,
      cooldown_until: null,
      probe_evidence_id: null,
      probe_started_at: null,
      probe_verified_at: null,
      last_reset: lastReset,
    });
    this.#saveState();
    this.appendAuditEvent({
      executor: executorType,
      event: 'RECOVERY_ADMITTED',
      admitted_by,
      evidence_id,
      reason,
      timestamp: admitTime,
    });
    return {
      executorType,
      state: 'CLOSED',
      admitted_by,
      evidence_id,
      reason,
      reset_time: admitTime,
      last_reset: lastReset,
    };
  }

  resetForTesting({ circuits = {}, lastLaunchTimes = {}, activeProcesses = {} } = {}) {
    this.circuits.clear();
    for (const [k, v] of Object.entries(circuits)) {
      this.circuits.set(k, { ...v });
    }
    this.lastLaunchTimes.clear();
    for (const [k, v] of Object.entries(lastLaunchTimes)) {
      this.lastLaunchTimes.set(k, v);
    }
    this.activeProcesses.clear();
    for (const [k, v] of Object.entries(activeProcesses)) {
      this.activeProcesses.set(k, v);
    }
    this.waitQueues.clear();
  }
}

export const runtimeGuard = new ExecutorRuntimeGuard();
