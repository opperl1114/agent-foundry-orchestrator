import {filterExecutors} from './operator-control.mjs';
// scheduler.mjs - PHASE 3 minimal local scheduler (multi-task, concurrency-safe)
//
// Plane boundary: Control Plane ONLY. The scheduler owns task locks, slot
// accounting, routing and bounded retry. It NEVER re-implements candidate /
// formal review / policy / Human Gate / formal writer lock / publish - all of
// that stays in vault-mcp (Governance Plane). Task truth remains
// tasks/<task_id>.json (atomic store); runtime/scheduler.json holds scheduler
// METADATA ONLY (queue, active ids, WAITING ids, events) - never a copy of
// task lifecycle state.
//
// Invariants:
//   - One task = one async chain (single-threaded event loop): author ->
//     reviewer -> fix -> governance is strictly sequential INSIDE a task.
//   - Different tasks run in parallel, bounded by max_concurrent_tasks (2).
//   - A task holds at most one Control Plane lock (locks/<task_id>.lock).
//   - WAITING_HUMAN parks the task: state persisted, lock + slot released.
//   - Executor failures become task-local FAILED state; one failing task
//     never crashes the scheduler loop or blocks other tasks.
//   - Bounded retry (max_executor_retries, default 1) for TRANSIENT executor
//     failures only. Governance deny / REVIEW_STALE / GOVERNANCE_ENV_REQUIRED /
//     MAX_REVISIONS_EXCEEDED / WRITE_CONFLICT / human_required are NEVER
//     retried.
//   - ROLE != PLATFORM: role assignment stays in the task definition; the
//     scheduler only checks capability constraints and current availability.

import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readTaskFile, taskFileExists, saveTaskAtomic, saveTaskWithVersion } from './store.mjs';
import {
  acquireTaskLock, releaseTaskLock, renewTaskLock, readLock, isLockStale,
} from './tasklock.mjs';
import { loadExecutorStatus } from './executor-status.mjs';
import { ADAPTERS } from './adapters.mjs';
import { executeTask, resumeGovernance } from '../orchestrator.mjs';
import { runtimeGuard as defaultRuntimeGuard } from './executor-runtime-guard.mjs';
import { resolveExecutorRoute } from './executor-router.mjs';
import { acceptanceBinding, verifyAcceptanceBinding } from './acceptance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

// A cancellation is sticky: never re-dispatch a cancelled task. FAILED is
// excluded because the bounded retry below deliberately re-dispatches it.
const NON_REVIVABLE_STATES = new Set(['CANCELLED']);
// running-like task states for the restart scan (Phase 1.1 states + Phase 2)
const RUNNING_LIKE_STATES = new Set(['AUTHOR_RUNNING', 'FIX_RUNNING', 'REVIEW_RUNNING', 'GOVERNANCE_PENDING', 'PUBLISHING']);

function LockHeldSync(taskId) {
  const err = new Error(`TASK_ALREADY_RUNNING: task ${taskId} is already active in this scheduler instance`);
  err.code = 'TASK_ALREADY_RUNNING';
  return err;
}

// Control Plane target coordination: at most one ACTIVE task may occupy the
// publish-sensitive stage (GOVERNANCE_PENDING..) for a given candidate target.
// This is a Control Plane optimization to reduce same-target publish races.
// The FORMAL writer conflict enforcement remains vault-mcp's writer lock.
export class TargetCoordinator {
  constructor() { this.holders = new Map(); } // target -> { task_id, acquired_at }
  acquire(task) {
    const target = task?.candidate?.target;
    if (!target) return true;
    const holder = this.holders.get(target);
    if (holder && holder.task_id !== task.task_id) return false;
    this.holders.set(target, { task_id: task.task_id, acquired_at: new Date().toISOString() });
    return true;
  }
  release(task) {
    const target = task?.candidate?.target;
    if (target && this.holders.get(target)?.task_id === task.task_id) this.holders.delete(target);
  }
  status() { return Object.fromEntries(this.holders); }
}

export class Scheduler {
  constructor({
    maxConcurrent = 2,          // PHASE 3 v1 default
    adapters = ADAPTERS,
    maxExecutorRetries = 1,     // bounded transient retry
    leaseMs = 15 * 60_000,
    makeBridge = null,          // test hook: (task) => bridgeOverride | null
    executorStatusDir = undefined,
    tasksDir = null,            // override for isolated tests (defaults to ROOT/tasks)
    runtimeGuard = defaultRuntimeGuard,
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.adapters = filterExecutors(adapters);
    this.maxExecutorRetries = maxExecutorRetries;
    this.leaseMs = leaseMs;
    this.makeBridge = makeBridge;
    this.executorStatus = loadExecutorStatus(executorStatusDir === undefined ? undefined : executorStatusDir);
    this.runtimeGuard = runtimeGuard;
    this.tasksDir = tasksDir ?? join(ROOT, 'tasks');
    this.locksDir = join(ROOT, 'locks');
    this.runtimeDir = join(ROOT, 'runtime');
    // Scheduler owns the on-disk layout; every entry point (enqueue/run/resume)
    // goes through a Scheduler, so ensuring the dirs here keeps the atomic
    // store, locks/ and runtime/scheduler.json writable from a fresh checkout.
    for (const d of [this.tasksDir, this.locksDir, this.runtimeDir]) {
      try { mkdirSync(d, { recursive: true }); } catch { /* read-only fs surfaces at write time */ }
    }
    this.orchestrator_instance_id = `af-orch-${randomUUID().slice(0, 8)}`;
    this.shutdownRequested = false;
    this.shutdownPromise = null;
    this.shutdownMode = null;
    this.queue = [];                 // QUEUED
    this.active = new Map();         // RUNNING: task_id -> entry {done, retries}
    this.waiting = new Set();        // WAITING (WAITING_HUMAN parked)
    this.coordination = new TargetCoordinator();
    this.events = [];
    this.recoveredStaleLocks = [];
  }

  #taskFile(taskId) { return join(this.tasksDir, `${taskId}.json`); }

  // Single writer for task lifecycle state: every lifecycle write goes through
  // saveTaskWithVersion, which advances state_version. A write that skipped the
  // version would let a stale recovery plan slip past the STALE_RECOVERY_PLAN
  // guard. (The initial persist of a new task is the one exception.)
  #save(task) { return saveTaskWithVersion(this.tasksDir, task); }

  // scheduler metadata ONLY - never a copy of task lifecycle state
  #persist() {
    try {
      mkdirSync(this.runtimeDir, { recursive: true });
      saveTaskAtomic(join(this.runtimeDir, 'scheduler.json'), {
        scheduler_id: this.orchestrator_instance_id,
        shutdown_requested: this.shutdownRequested,
        max_concurrent_tasks: this.maxConcurrent,
        queue: [...this.queue],            // QUEUED
        active: [...this.active.keys()],   // RUNNING
        waiting: [...this.waiting],        // WAITING (WAITING_HUMAN parked)
        target_holders: this.coordination.status(),
        stale_lock_recovered: this.recoveredStaleLocks,
        events: this.events.slice(-200),
      });
    } catch { /* metadata persistence must never break the control loop */ }
  }

  #event(kind, data = {}) {
    this.events.push({ at: new Date().toISOString(), kind, ...data });
    this.#persist();
  }

  // enqueue(taskObjectOrFilePath) -> task_id. Idempotent. The task definition
  // is persisted into the atomic task store so tasks/<id>.json stays the only
  // lifecycle truth.
  enqueue(taskOrFile) {
    if (this.shutdownRequested) {
      const err = new Error('SYSTEM_SHUTTING_DOWN: scheduler is shutting down, refusing new tasks');
      err.code = 'SYSTEM_SHUTTING_DOWN';
      throw err;
    }
    const task = typeof taskOrFile === 'string' ? readTaskFile(taskOrFile) : taskOrFile;
    const id = task?.task_id;
    if (!id) throw new Error('enqueue requires a task with task_id');
    if (this.active.has(id) || this.waiting.has(id) || this.queue.includes(id)) return id;
    if (!taskFileExists(this.#taskFile(id))) {
      const persisted = {
        state: 'CREATED', state_version: 0, runs: [], revisions_used: 1,
        ...task,
      };
      // Bind the acceptance trust anchor at creation so a later edit of the
      // command (the task file is writable by whoever can reach tasks/) is
      // detected before the command is executed.
      persisted.acceptance_binding = persisted.acceptance_binding ?? acceptanceBinding(persisted);
      saveTaskAtomic(this.#taskFile(id), persisted);
    }
    this.queue.push(id);
    this.#event('enqueue', { task_id: id });
    return id;
  }

  // Start as many queued tasks as free slots allow. Returns scheduler status.
  runNext() {
    if (this.shutdownRequested) {
      return this.status();
    }
    while (this.queue.length && this.active.size < this.maxConcurrent) {
      const id = this.queue.shift();
      this.runTask(id);
    }
    this.#persist();
    return this.status();
  }

  // Immediate start. Throws synchronously on: unknown task, capacity, or a
  // valid lock held by another owner (TASK_ALREADY_RUNNING).
  runTask(taskId) {
    if (this.shutdownRequested) {
      const err = new Error('SYSTEM_SHUTTING_DOWN: scheduler is shutting down, refusing new tasks');
      err.code = 'SYSTEM_SHUTTING_DOWN';
      throw err;
    }
    if (!taskFileExists(this.#taskFile(taskId))) throw new Error(`task not found: ${taskId}`);
    if (this.active.has(taskId)) throw LockHeldSync(taskId);
    if (this.active.size >= this.maxConcurrent) {
      const err = new Error(`SCHEDULER_AT_CAPACITY: ${this.active.size}/${this.maxConcurrent} slots busy; use enqueue + runNext`);
      err.code = 'SCHEDULER_AT_CAPACITY';
      throw err;
    }
    return this.#start(taskId, { resume: false });
  }

  // Resume a WAITING_HUMAN task through the Human Gate correlation path: only
  // this task's own saved candidate_id is re-queried against vault-mcp.
  resumeTask(taskId) {
    if (this.shutdownRequested) {
      const err = new Error('SYSTEM_SHUTTING_DOWN: scheduler is shutting down, refusing new tasks');
      err.code = 'SYSTEM_SHUTTING_DOWN';
      throw err;
    }
    const task = readTaskFile(this.#taskFile(taskId));
    if (task.state !== 'WAITING_HUMAN') {
      const err = new Error(`NOT_WAITING_HUMAN: task ${taskId} is ${task.state}, not WAITING_HUMAN`);
      err.code = 'NOT_WAITING_HUMAN';
      throw err;
    }
    if (this.active.size >= this.maxConcurrent) {
      const err = new Error('SCHEDULER_AT_CAPACITY: no free slot for resume');
      err.code = 'SCHEDULER_AT_CAPACITY';
      throw err;
    }
    return this.#start(taskId, { resume: true });
  }

  cancelTask(taskId) {
    const task = readTaskFile(this.#taskFile(taskId));
    const wasActive = this.active.has(taskId);
    const entry = this.active.get(taskId) ?? null;
    this.queue = this.queue.filter((id) => id !== taskId);
    // PHASE 4 Closure: request termination of the ACTIVE executor process for
    // this task - precisely, by its registered run identity (never by
    // platform name, never "latest process"). The cancel returns evidence.
    if (wasActive && entry?.adapterType) {
      const adapter = this.adapters[entry.adapterType];
      const runIds = entry.activeRunIds?.size
        ? [...entry.activeRunIds]
        : (entry.activeRunId ? [entry.activeRunId] : []);
      if (adapter?.cancel && runIds.length) {
        // Every run of this task is terminated precisely by its own id. Keep the
        // evidence object when it is available synchronously (single run, or a
        // synchronous adapter) so the termination evidence on the task is
        // populated rather than left as an unresolved promise.
        const results = runIds.map((id) => adapter.cancel(id));
        if (results.length === 1) {
          entry.cancelEvidence = results[0];
        } else if (results.every((r) => r && typeof r.then !== 'function')) {
          entry.cancelEvidence = { ...results[0], run_ids: runIds };
        } else {
          entry.cancelEvidence = Promise.all(results);
        }
      }
    }
    if (!TERMINAL_STATES.has(task.state)) {
      task.state = 'CANCELLED';
      task.cancel_requested_at = task.cancel_requested_at ?? new Date().toISOString();
      task.cancelled_at = new Date().toISOString();
      task.cancel_reason = task.cancel_reason ?? 'cancelled by operator';
      task.cancelled_by = this.orchestrator_instance_id;
      task.active_run_id = entry?.activeRunId ?? null;
      if (entry?.cancelEvidence) {
        task.termination = {
          requested: true,
          pid: entry.cancelEvidence.pid ?? null,
          signal: entry.cancelEvidence.termination_signal ?? null,
          forced: entry.cancelEvidence.forced ?? false,
          observed_exit: entry.cancelEvidence.process_exit_observed ?? null,
          already_exited: entry.cancelEvidence.already_exited ?? false,
        };
      }
      this.#save(task);
    }
    // WAITING_HUMAN/terminal rows: only the Control Plane row is cancelled;
    // governance audit trail (candidate/review/approval) is never touched.
    this.#event('cancel', { task_id: taskId, was_active: wasActive });
    return task;
  }

  status() {
    return {
      orchestrator_instance_id: this.orchestrator_instance_id,
      shutdown_requested: this.shutdownRequested,
      max_concurrent_tasks: this.maxConcurrent,
      queued: [...this.queue],
      active: [...this.active.keys()],
      waiting: [...this.waiting],
      targets: this.coordination.status(),
      executor_availability: Object.fromEntries(
        [...this.executorStatus].map(([id, s]) => [id, `${s.capability_status}/${s.availability_status}`]),
      ),
      events_tail: this.events.slice(-10),
    };
  }

  // Graceful shutdown handler (PHASE 7-A):
  // 1. Mark shutdown_requested -> refuse new tasks (SYSTEM_SHUTTING_DOWN)
  // 2. Drain queued tasks
  // 3. Terminate active executor child processes reusing existing cancelTask / adapter.cancel
  // 4. Wait bounded timeout for runs to settle, releasing locks and slot leases
  async shutdown({ timeoutMs = 5000, mode = 'cancel', signal = 'SIGTERM' } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownRequested = true;
    this.shutdownMode = mode;
    this.#event('shutdown_requested', { signal, mode, active_count: this.active.size, queued_count: this.queue.length });

    // 1. Drain queued tasks so no new work starts from queue
    const queuedIds = [...this.queue];
    this.queue = [];
    for (const qid of queuedIds) {
      this.#event('queue_drained_on_shutdown', { task_id: qid });
    }

    // 2. Terminate active executor child processes via existing cancellation mechanism
    const activeTasks = [...this.active.entries()];
    for (const [taskId, entry] of activeTasks) {
      if (mode === 'cancel') {
        this.cancelTask(taskId);
      } else if (mode === 'interrupt') {
        // Precise child process termination without marking task CANCELLED or FAILED
        if (entry?.adapterType && entry.activeRunId) {
          const adapter = this.adapters[entry.adapterType];
          if (adapter?.cancel) {
            entry.cancelEvidence = adapter.cancel(entry.activeRunId);
          }
        }
      }
    }

    // 3. Wait bounded timeout for active task chains to settle
    const activePromises = activeTasks.map(([, e]) => e.done);
    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });

    this.shutdownPromise = Promise.race([
      Promise.all(activePromises),
      timeoutPromise,
    ]).then(() => {
      clearTimeout(timer);
      this.#event('shutdown_completed', {
        signal,
        mode,
        remaining_active: this.active.size,
      });
      this.#persist();
      return {
        shutdown_completed: true,
        remaining_active: this.active.size,
        queued_drained: queuedIds.length,
      };
    });

    return this.shutdownPromise;
  }

  installSignalHandlers({ exitOnComplete = true, signalHandler = null } = {}) {
    const onSignal = async (sig) => {
      try {
        await this.shutdown({ signal: sig });
        signalHandler?.(sig);
      } finally {
        if (exitOnComplete) {
          process.exit(0);
        }
      }
    };
    const onSigterm = () => onSignal('SIGTERM');
    const onSigint = () => onSignal('SIGINT');
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
    return {
      uninstall: () => {
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('SIGINT', onSigint);
      },
    };
  }

  // Await all in-flight task chains until the scheduler is quiescent (test/E2E
  // convenience). Loops because finishing chains synchronously free slots and
  // start queued tasks AFTER this method may have taken its first snapshot.
  async waitAll() {
    for (;;) {
      const running = [...this.active.values()].map((e) => e.done);
      if (running.length) await Promise.all(running);
      if (!this.queue.length && !this.active.size) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // Restart scan: RUNNING-like task states with no valid lock were
  // interrupted. They are REPORTED (interrupted/recoverable) and never
  // auto-marked COMPLETED.
  scanInterrupted() {
    const out = [];
    let files = [];
    try { files = readdirSync(this.tasksDir); } catch { return out; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let task;
      try { task = readTaskFile(join(this.tasksDir, f)); } catch {
        out.push({ file: f, error: 'unreadable task file' });
        continue;
      }
      if (!RUNNING_LIKE_STATES.has(task.state)) continue;
      if (this.active.has(task.task_id)) continue;
      const lock = readLock(this.locksDir, task.task_id);
      const validLock = !!lock && !isLockStale(lock);
      out.push({
        task_id: task.task_id,
        state: task.state,
        interrupted: !validLock,
        lock_held: validLock,
        recoverable: !!(task.author_session_ref && task.author_session_executor_type)
          || task.state === 'GOVERNANCE_PENDING'
          || task.state === 'PUBLISHING',
        note: 'running-like task without a valid lock; reported by restart scan, never auto-COMPLETED',
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ internals

  #start(taskId, { resume }) {
    // 1. Control Plane ownership (stale locks recovered + recorded; valid
    //    locks from another owner rejected with TASK_ALREADY_RUNNING).
    let lockInfo;
    try {
      lockInfo = acquireTaskLock(this.locksDir, taskId, {
        orchestratorInstanceId: this.orchestrator_instance_id,
        leaseMs: this.leaseMs,
      });
    } catch (err) {
      this.#event('lock_rejected', { task_id: taskId, reason: String(err?.message ?? err).slice(0, 200) });
      throw err;
    }
    if (lockInfo.stale_lock_recovered) {
      this.recoveredStaleLocks.push({ task_id: taskId, at: new Date().toISOString(), ...lockInfo.recovered_from });
      this.#event('stale_lock_recovered', { task_id: taskId, stale_lock_recovered: true, ...lockInfo.recovered_from });
    }
    // 2. Availability pre-flight (capability/availability separation). A task
    //    naming an UNAVAILABLE executor fails task-locally; the scheduler
    //    never even attempts to start that executor.
    let fallbacks = [];
    if (!resume) {
      let task = readTaskFile(this.#taskFile(taskId));
      const blocked = this.#preflight(task);
      if (blocked) {
        task.state = 'FAILED';
        task.failure_reason = blocked.reason;
        task.retryable = false;
        this.#save(task);
        releaseTaskLock(this.locksDir, taskId, lockInfo.lock);
        this.#event('preflight_rejected', { task_id: taskId, executor: blocked.executor, availability: 'UNAVAILABLE' });
        return null; // task-local failure; scheduler keeps running
      }

      // PHASE 6-C: Multi Executor Routing
      const needsAuthorRouting = !task.author_executor || task.author_executor === 'auto';
      if (needsAuthorRouting) {
        const route = resolveExecutorRoute(task, {
          role: 'author',
          availabilityMap: this.executorStatus,
          runtimeGuard: this.runtimeGuard,
          adapters: this.adapters,
        });
        if (!route.primary) {
          task.state = 'FAILED';
          task.failure_reason = 'NO_ELIGIBLE_EXECUTOR: no available executor satisfies task constraints and runtime guard';
          task.retryable = false;
          this.#save(task);
          releaseTaskLock(this.locksDir, taskId, lockInfo.lock);
          this.#event('preflight_rejected', { task_id: taskId, executor: 'none', availability: 'UNAVAILABLE' });
          return null;
        }
        task.author_executor = route.primary;
        fallbacks = [...route.fallbacks];
        this.#save(task);
        this.#event('executor_routed', {
          task_id: taskId,
          role: 'author',
          primary: route.primary,
          fallbacks: route.fallbacks,
        });
      } else if (Array.isArray(task.fallbacks)) {
        fallbacks = [...task.fallbacks];
      } else if (task.allow_fallback === true) {
        const route = resolveExecutorRoute(task, {
          role: 'author',
          availabilityMap: this.executorStatus,
          runtimeGuard: this.runtimeGuard,
          adapters: this.adapters,
        });
        fallbacks = [...route.fallbacks];
      }

      if (task.reviewer_executor === 'auto') {
        const revRoute = resolveExecutorRoute(task, {
          role: 'reviewer',
          availabilityMap: this.executorStatus,
          runtimeGuard: this.runtimeGuard,
          adapters: this.adapters,
        });
        if (revRoute.primary) {
          task.reviewer_executor = revRoute.primary;
          this.#save(task);
          this.#event('executor_routed', {
            task_id: taskId,
            role: 'reviewer',
            primary: revRoute.primary,
            fallbacks: revRoute.fallbacks,
          });
        }
      }
    }
    // 3. Run the task chain: one async chain per task (strict intra-task
    //    ordering), parallel across tasks up to max_concurrent_tasks.
    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });
    const entry = {
      task_id: taskId, started_at: new Date().toISOString(), retries: 0, done,
      adapterType: null, activeRunId: null, activeRunIds: new Set(),
      fallbacks,
      // populated by the run chain on every executor start so cancelTask can
      // target the precise active run identity (never "latest process"). A plan
      // batch can have several runs in flight, so every id is tracked.
      onRunStart: (runId, adapterType) => {
        entry.activeRunId = runId;
        entry.activeRunIds.add(runId);
        entry.adapterType = adapterType;
      },
      cancelRequested: () => { this.#event('cancel_deferred', { task_id: taskId }); },
    };
    this.active.set(taskId, entry);
    // lease heartbeat so long executor runs are not orphaned as stale
    const heartbeat = setInterval(() => {
      try { renewTaskLock(this.locksDir, taskId, lockInfo.lock, this.leaseMs); } catch { /* released elsewhere */ }
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    this.#runChain(taskId, lockInfo.lock, { resume, entry, heartbeat }).finally(resolveDone);
    this.#event(resume ? 'resume_started' : 'task_started', { task_id: taskId });
    this.#persist();
    return entry;
  }

  async #runChain(taskId, lock, { resume, entry, heartbeat }) {
    try {
      const task = resume ? await this.#resumeOnce(taskId) : await this.#executeOnce(taskId, entry);
      if (task?.state === 'WAITING_HUMAN') {
        // parked: state was persisted by executeTask; release lock + slot,
        // keep the target-coordination lease (same-target tasks must not
        // race the Human Gate window) and wait for an explicit resumeTask.
        this.waiting.add(taskId);
        this.#event('task_waiting_human', { task_id: taskId, candidate_id: task.governance?.candidate_id ?? null });
      }
    } finally {
      clearInterval(heartbeat);
      this.active.delete(taskId);
      let finalTask = null;
      try { finalTask = readTaskFile(this.#taskFile(taskId)); } catch { /* gone */ }
      if (finalTask && TERMINAL_STATES.has(finalTask.state)) {
        this.coordination.release(finalTask); // free the target lease on terminal states
      }
      releaseTaskLock(this.locksDir, taskId, lock);
      this.#persist();
      if (!this.shutdownRequested) {
        this.runNext(); // a slot just freed up
      }
    }
  }

  // executeTask already converts executor exceptions into task-local FAILED
  // state; bounded transient retry is applied to that returned result.
  async #executeOnce(taskId, entry) {
    let attempt = 0;
    for (;;) {
      let task = null;
      try {
        const fresh = readTaskFile(this.#taskFile(taskId));
        // The task may have reached a state since it was queued that must never
        // be re-entered (for example an operator cancellation). FAILED is
        // excluded on purpose: the bounded retry below re-dispatches it.
        if (NON_REVIVABLE_STATES.has(fresh.state)) {
          return fresh;
        }
        // The task file is writable by anything that can reach tasks/, and the
        // CLI validated it once, at submission. Re-validate the acceptance
        // trust anchor before spending an executor on it.
        const bindingCheck = verifyAcceptanceBinding(fresh);
        if (!bindingCheck.ok) {
          fresh.state = 'FAILED';
          fresh.failure_reason = 'TASK_FILE_TAMPERED';
          fresh.error_classification = {
            category: 'ENVIRONMENT_FAULT',
            retryable: false,
            safety_action: 'NONE',
            reason: 'acceptance trust anchor changed after task creation',
          };
          fresh.retryable = false;
          this.#save(fresh);
          this.#event('task_file_tampered', { task_id: taskId });
          return fresh;
        }
        const bridgeOverride = this.makeBridge ? this.makeBridge(fresh) : null;
        try {
          // PHASE 4: tag the task with its tasks dir so saveTask writes to the
          // right place (the scheduler's tasksDir, not the global TASKS_DIR).
          Object.defineProperty(fresh, '__tasksDir', { value: this.tasksDir, enumerable: false });
          task = await executeTask(fresh, this.adapters, {
            governanceBridge: bridgeOverride,
            targetCoordination: this.coordination,
            onRunStart: entry.onRunStart,
            isShutdownRequested: () => this.shutdownRequested,
            shutdownMode: () => this.shutdownMode,
          });
        } finally {
          bridgeOverride?.stop?.();
        }
      } catch (err) {
        // defensive: even a hard exception becomes task-local state
        const msg = String(err?.message ?? err);
        try {
          const t = readTaskFile(this.#taskFile(taskId));
          if (!TERMINAL_STATES.has(t.state)) {
            if (this.shutdownRequested) {
              this.#event('shutdown_interrupted', { task_id: taskId, state: t.state });
            } else {
              t.state = 'FAILED';
              t.failure_reason = msg.slice(0, 300);
              this.#save(t);
            }
          }
        } catch { /* task file unreadable */ }
        this.#event('task_chain_error', { task_id: taskId, error: msg.slice(0, 300) });
        return null;
      }
      if (this.shutdownRequested) {
        return task;
      }
      const category = task.error_classification?.category;
      const isPolicyOrAuth = category === 'ACCOUNT_POLICY' || category === 'AUTH_FAILURE';
      if (task.state === 'FAILED' && isPolicyOrAuth) {
        // Strict safety invariant: ACCOUNT_POLICY and AUTH_FAILURE fail closed, NEVER fallback
        this.#event('fallback_forbidden', { task_id: taskId, category, reason: 'account or auth policy failure fails closed' });
        return task;
      }

      const isRateLimit = category === 'RATE_LIMIT';
      const isTransient = category === 'TRANSIENT_FAULT';
      const isRetryable = task.error_classification?.retryable === true || task.retryable === true;

      if (task.state === 'FAILED' && (isTransient || isRateLimit || isRetryable)) {
        if (!isRateLimit && isRetryable && attempt < this.maxExecutorRetries) {
          attempt += 1;
          entry.retries = attempt;
          this.#event('executor_retry', {
            task_id: taskId, attempt, bounded_by: 'max_executor_retries',
            error: String(task.failure_reason).slice(0, 200),
          });
          continue; // bounded retry of current executor
        }

        // Current executor exhausted or rate-limited: check for fallbacks
        while ((isTransient || isRateLimit) && entry.fallbacks && entry.fallbacks.length > 0) {
          const prevExecutor = task.author_executor;
          const nextExecutor = entry.fallbacks.shift();
          // Availability / circuit check for nextExecutor
          const st = this.executorStatus.get(nextExecutor);
          if (st && st.availability_status === 'UNAVAILABLE') {
            continue; // skip unavailable fallback
          }
          if (this.runtimeGuard && !this.runtimeGuard.canExecute(nextExecutor)) {
            continue; // skip circuit-blocked fallback
          }
          task.author_executor = nextExecutor;
          task.author_session_ref = null;
          task.author_session_executor_type = null;
          task.state = 'CREATED';
          task.failure_reason = null;
          task.error_classification = null;
          this.#save(task);
          attempt = 0;
          entry.retries = 0;
          this.#event('executor_fallback', {
            task_id: taskId,
            from: prevExecutor,
            to: nextExecutor,
            category,
            remaining_fallbacks: [...entry.fallbacks],
          });
          break; // proceed to rerun
        }
        if (task.state === 'CREATED') {
          continue; // rerun with the chosen fallback
        }

        this.#event('retries_exhausted', { task_id: taskId, retries_used: attempt });
      }
      return task;
    }
  }

  // WAITING_HUMAN resume: NO retry (governance verdicts are never transient).
  // Only this task's saved candidate_id is used (enforced inside
  // resumeGovernance); a thrown error is converted to task-local FAILED.
  async #resumeOnce(taskId) {
    const fresh = readTaskFile(this.#taskFile(taskId));
    const bridgeOverride = this.makeBridge ? this.makeBridge(fresh) : null;
    try {
      return await resumeGovernance(taskId, { adapters: this.adapters, bridgeOverride });
    } catch (err) {
      const msg = String(err?.message ?? err);
      try {
        const t = readTaskFile(this.#taskFile(taskId));
        if (!TERMINAL_STATES.has(t.state)) {
          t.state = 'FAILED';
          t.failure_reason = msg.slice(0, 300);
          this.#save(t);
        }
      } catch { /* ignore */ }
      this.#event('resume_error', { task_id: taskId, error: msg.slice(0, 300) });
      try { return readTaskFile(this.#taskFile(taskId)); } catch { return null; }
    } finally {
      bridgeOverride?.stop?.();
    }
  }

  // Availability pre-flight: explicit executor choices are checked against the
  // canonical availability projection. 'auto' selection is left to
  // selectExecutor (which enforces capability constraints like codex MCP).
  #preflight(task) {
    if (this.shutdownRequested) {
      return {
        executor: 'none',
        reason: 'SYSTEM_SHUTTING_DOWN: scheduler is shutting down; refusing new task start',
      };
    }
    const wanted = new Set();
    for (const k of ['author_executor', 'reviewer_executor']) {
      const v = task?.[k];
      if (v && v !== 'auto') wanted.add(v);
    }
    for (const id of wanted) {
      const st = this.executorStatus.get(id);
      if (st && st.availability_status === 'UNAVAILABLE') {
        return {
          executor: id,
          reason: `EXECUTOR_UNAVAILABLE: ${id} availability=UNAVAILABLE (${st.reason ?? 'unknown'}); scheduler must not attempt to start it`,
        };
      }
      if (this.runtimeGuard && !this.runtimeGuard.canExecute(id)) {
        const c = this.runtimeGuard.getCircuitState(id);
        this.runtimeGuard.recordLaunchBlocked?.(id, c.reason ?? 'preflight circuit blocked');
        return {
          executor: id,
          reason: `EXECUTOR_CIRCUIT_OPEN: ${id} runtime circuit is ${c.state} (${c.reason ?? 'blocked'}); scheduler must not attempt to start it`,
        };
      }
    }
    return null;
  }
}
