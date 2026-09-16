// runtime-safety.test.mjs - PHASE 5-A Executor Runtime Safety Layer tests
//
// Tests:
//   Runtime-A: 403 -> classifier -> OPEN_MANUAL_RESET -> retryable=false -> scheduler no retry
//   Runtime-B: Executor isolation: agy OPEN does not block claude
//   Runtime-C: Crash restart recovery: OPEN_MANUAL_RESET state persists across restarts
//   Runtime-D: Concurrency cap: max_parallel=1 strictly serializes execution
//   Runtime-E: Manual reset authorization: OPEN_MANUAL_RESET blocks, no auto-reset, operator metadata, permits launch after reset
//   Runtime-F: Burst launch protection: 10 concurrent requests serialize with peak active process <= 1

import { test } from 'node:test';
import './helpers/tasks-dir-fixture.mjs';
import './helpers/executors-fixture.mjs';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyExecutionError } from '../lib/executor-error-classifier.mjs';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { saveTaskAtomic, readTaskFile } from '../lib/store.mjs';
import { detectThinkingDeadLoop } from '../lib/adapters.mjs';
import './helpers/acceptance-allowlist.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeExecDir(dir) {
  const execDir = join(dir, 'executors');
  mkdirSync(execDir, { recursive: true });
  writeFileSync(join(execDir, 'claude.json'), JSON.stringify({
    executor_id: 'claude', capabilities_audit: { m1: 'PASS' }, blockers: [],
  }));
  writeFileSync(join(execDir, 'antigravity.json'), JSON.stringify({
    executor_id: 'antigravity', capabilities_audit: { m1: 'PASS' }, blockers: [],
  }));
  writeFileSync(join(execDir, 'codex.json'), JSON.stringify({
    executor_id: 'codex', capabilities_audit: { m1: 'PASS' }, blockers: [],
  }));
  return execDir;
}

const PASS = { decision: 'PASS', summary: 'ok', issues: [], required_changes: [], evidence: ['e'] };

function makeScriptedFake(type, script) {
  let callCount = 0;
  return {
    type,
    supportsMcpUnattended: true,
    get calls() { return callCount; },
    async run(capsule) {
      callCount += 1;
      const idx = Math.min(callCount - 1, script.length - 1);
      const res = script[idx];
      return typeof res === 'function' ? await res(capsule, callCount) : res;
    },
    async resume(sessionRef, capsule) {
      callCount += 1;
      const idx = Math.min(callCount - 1, script.length - 1);
      const res = script[idx];
      return typeof res === 'function' ? await res(capsule, callCount) : res;
    },
    cancel() { return { cancelled: true }; },
  };
}

test('Runtime-A: agy 403 -> classifier -> OPEN_MANUAL_RESET -> retryable=false -> scheduler does not retry', async () => {
  const dir = tmpDir('af-rt-a-');
  const tasksDir = join(dir, 'tasks');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const execDir = makeExecDir(dir);

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
  }));
  writeFileSync(stateFile, JSON.stringify({})); // start clean

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile });

  // 1. Verify classifier directly on 403 TOS error
  const raw403 = {
    exit_code: 1,
    stderr: '403 PERMISSION_DENIED: This service has been disabled in this account for violation of Terms of Service',
    stdout: '',
  };
  const classification = classifyExecutionError('antigravity', raw403);
  assert.strictEqual(classification.category, 'ACCOUNT_POLICY');
  assert.strictEqual(classification.retryable, false);
  assert.strictEqual(classification.safety_action, 'OPEN_MANUAL_RESET');

  // 2. Mock adapter that returns this 403 error
  let agyRuns = 0;
  const failingAgy = makeScriptedFake('antigravity', [
    () => {
      agyRuns += 1;
      guard.recordResult('antigravity', classification);
      return {
        executor_run_id: `RUN-${randomUUID().slice(0, 8)}`,
        executor_type: 'antigravity',
        assigned_role: 'author',
        status: 'failed',
        session_ref: null,
        structured_result: null,
        exit_code: 1,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: raw403.stderr,
        error_classification: classification,
      };
    },
  ]);

  const sched = new Scheduler({
    maxConcurrent: 2,
    maxExecutorRetries: 3, // scheduler configured with retries
    executorStatusDir: execDir,
    tasksDir,
    runtimeGuard: guard,
    adapters: {
      antigravity: failingAgy,
      claude: makeScriptedFake('claude', [{ sessionRef: 'R1', structured_result: { parsed: PASS }, status: 'completed', exit_code: 0 }]),
      codex: makeScriptedFake('codex', []),
    },
  });

  const taskId = 'TASK-RT-A';
  const taskObj = {
    task_id: taskId,
    goal: 'test 403',
    acceptance: 'test',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: dir,
    author_executor: 'antigravity',
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 3,
    red_lines: [],
    review_rules: [],
    state: 'CREATED',
    runs: [],
  };
  saveTaskAtomic(join(tasksDir, `${taskId}.json`), taskObj);

  sched.enqueue(taskObj);
  sched.runNext();
  await sched.waitAll();

  const finalTask = readTaskFile(join(tasksDir, `${taskId}.json`));
  assert.strictEqual(finalTask.state, 'FAILED');
  assert.strictEqual(finalTask.retryable, false);
  assert.strictEqual(finalTask.error_classification?.category, 'ACCOUNT_POLICY');

  // Critical check: even though maxExecutorRetries=3, agy was called EXACTLY ONCE! Zero retries!
  assert.strictEqual(agyRuns, 1, '403 must never be retried by the scheduler');

  // Circuit breaker state check
  const circuit = guard.getCircuitState('antigravity');
  assert.strictEqual(circuit.state, 'OPEN_MANUAL_RESET');

  rmSync(dir, { recursive: true, force: true });
});

test('Runtime-B: executor isolation: agy OPEN does not block claude', async () => {
  const dir = tmpDir('af-rt-b-');
  const tasksDir = join(dir, 'tasks');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const execDir = makeExecDir(dir);

  // Antigravity is already OPEN
  writeFileSync(stateFile, JSON.stringify({
    antigravity: { state: 'OPEN_MANUAL_RESET', reason: 'TOS_VIOLATION', opened_at: new Date().toISOString() },
  }));
  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
    claude: { max_parallel: 2, min_interval_ms: 10 },
  }));

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile });
  assert.strictEqual(guard.canExecute('antigravity'), false);
  assert.strictEqual(guard.canExecute('claude'), true);

  const claudeFake = makeScriptedFake('claude', [
    { executor_run_id: 'R1', executor_type: 'claude', assigned_role: 'author', status: 'completed', session_ref: 'C-S1', structured_result: { result: 'ok' }, exit_code: 0 },
    { executor_run_id: 'R2', executor_type: 'claude', assigned_role: 'reviewer', status: 'completed', session_ref: 'C-R1', structured_result: { result: '```json\n' + JSON.stringify(PASS) + '\n```' }, exit_code: 0 },
  ]);

  const sched = new Scheduler({
    maxConcurrent: 2,
    executorStatusDir: execDir,
    tasksDir,
    runtimeGuard: guard,
    adapters: {
      claude: claudeFake,
      antigravity: makeScriptedFake('antigravity', []),
      codex: makeScriptedFake('codex', []),
    },
  });

  // Task 1 using claude should succeed completely
  const taskClaude = 'TASK-RT-CLAUDE';
  const taskClaudeObj = {
    task_id: taskClaude,
    goal: 'claude task',
    acceptance: 'a',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: dir,
    author_executor: 'claude',
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 2,
    red_lines: [],
    review_rules: [],
    state: 'CREATED',
    runs: [],
  };
  saveTaskAtomic(join(tasksDir, `${taskClaude}.json`), taskClaudeObj);

  // Task 2 using antigravity should be rejected at preflight
  const taskAgy = 'TASK-RT-AGY';
  const taskAgyObj = {
    task_id: taskAgy,
    goal: 'agy task',
    acceptance: 'a',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: dir,
    author_executor: 'antigravity',
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 2,
    red_lines: [],
    review_rules: [],
    state: 'CREATED',
    runs: [],
  };
  saveTaskAtomic(join(tasksDir, `${taskAgy}.json`), taskAgyObj);

  sched.enqueue(taskClaudeObj);
  sched.enqueue(taskAgyObj);
  sched.runNext();
  await sched.waitAll();

  const cResult = readTaskFile(join(tasksDir, `${taskClaude}.json`));
  const aResult = readTaskFile(join(tasksDir, `${taskAgy}.json`));

  assert.strictEqual(cResult.state, 'COMPLETED', `claude task must complete normally: ${cResult.failure_reason}`);
  assert.strictEqual(aResult.state, 'FAILED');
  assert.match(aResult.failure_reason, /EXECUTOR_CIRCUIT_OPEN/);

  rmSync(dir, { recursive: true, force: true });
});

test('Runtime-C: restart recovery: OPEN_MANUAL_RESET state persists and blocks launch on restart', async () => {
  const dir = tmpDir('af-rt-c-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
  }));
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      reason: 'TOS_VIOLATION (403 account disabled on 2026-09-05)',
      opened_at: '2026-09-05T00:00:00.000Z',
    },
  }));

  // Simulate cold boot after orchestrator restart
  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile });

  // 1. Verify circuit state loaded from disk
  const state = guard.getCircuitState('antigravity');
  assert.strictEqual(state.state, 'OPEN_MANUAL_RESET');
  assert.strictEqual(state.reason, 'TOS_VIOLATION (403 account disabled on 2026-09-05)');
  assert.strictEqual(guard.canExecute('antigravity'), false);

  // 2. acquireSlot must immediately reject without spawning
  await assert.rejects(
    async () => { await guard.acquireSlot('antigravity'); },
    (err) => {
      assert.strictEqual(err.code, 'CIRCUIT_OPEN');
      assert.match(err.message, /OPEN_MANUAL_RESET/);
      return true;
    }
  );

  rmSync(dir, { recursive: true, force: true });
});

test('Runtime-D: concurrency limit (max_parallel=1) strictly serializes execution', async () => {
  const dir = tmpDir('af-rt-d-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
  }));
  writeFileSync(stateFile, JSON.stringify({})); // clean

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile });

  let concurrentProcesses = 0;
  let maxObservedConcurrent = 0;

  async function simulateRun(durationMs) {
    await guard.acquireSlot('antigravity');
    try {
      concurrentProcesses += 1;
      maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrentProcesses);
      await new Promise((r) => setTimeout(r, durationMs));
    } finally {
      concurrentProcesses -= 1;
      guard.releaseSlot('antigravity');
    }
  }

  // Launch two operations in parallel
  const op1 = simulateRun(60);
  const op2 = simulateRun(60);

  await Promise.all([op1, op2]);

  assert.strictEqual(maxObservedConcurrent, 1, 'max parallel processes must never exceed 1');
  assert.strictEqual(concurrentProcesses, 0);

  rmSync(dir, { recursive: true, force: true });
});

test('Runtime-E: manual reset authorization: OPEN_MANUAL_RESET blocks launch, no auto-reset, operator records audit metadata, permits launch after reset', async () => {
  const dir = tmpDir('af-rt-e-');
  const tasksDir = join(dir, 'tasks');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const execDir = makeExecDir(dir);

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
  }));
  // 1. antigravity starts in OPEN_MANUAL_RESET state
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      reason: 'TOS_VIOLATION (historical accident 2026-09-05)',
      opened_at: '2026-09-05T00:00:00.000Z',
    },
  }));

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile });

  let agyRuns = 0;
  const agyFake = makeScriptedFake('antigravity', [
    () => {
      agyRuns += 1;
      return {
        executor_run_id: 'RUN-AGY-1',
        executor_type: 'antigravity',
        assigned_role: 'author',
        status: 'completed',
        session_ref: 'S-AGY-1',
        structured_result: { decision: 'PASS' },
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      };
    },
  ]);

  const sched = new Scheduler({
    maxConcurrent: 2,
    executorStatusDir: execDir,
    tasksDir,
    runtimeGuard: guard,
    adapters: {
      antigravity: agyFake,
      claude: makeScriptedFake('claude', [{
        executor_run_id: 'R1',
        executor_type: 'claude',
        assigned_role: 'reviewer',
        status: 'completed',
        session_ref: 'C-R1',
        structured_result: { result: '```json\n' + JSON.stringify(PASS) + '\n```' },
        exit_code: 0,
      }]),
      codex: makeScriptedFake('codex', []),
    },
  });

  // Step 1: verify preflight rejection when circuit is OPEN_MANUAL_RESET
  const task1Id = 'TASK-RT-E-BLOCKED';
  const task1 = {
    task_id: task1Id,
    goal: 'try launch blocked executor',
    acceptance: 'test',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: dir,
    author_executor: 'antigravity',
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 1,
    red_lines: [],
    review_rules: [],
    state: 'CREATED',
    runs: [],
  };
  saveTaskAtomic(join(tasksDir, `${task1Id}.json`), task1);
  sched.enqueue(task1);
  sched.runNext();
  await sched.waitAll();

  const finalTask1 = readTaskFile(join(tasksDir, `${task1Id}.json`));
  assert.strictEqual(finalTask1.state, 'FAILED');
  assert.strictEqual(finalTask1.retryable, false);
  assert.match(finalTask1.failure_reason, /EXECUTOR_CIRCUIT_OPEN/);
  assert.strictEqual(agyRuns, 0, 'executor must not be called when circuit is OPEN_MANUAL_RESET');

  // Step 2: verify no auto-reset occurs even over time or multiple queries
  const midState = guard.getCircuitState('antigravity');
  assert.strictEqual(midState.state, 'OPEN_MANUAL_RESET');
  assert.strictEqual(guard.canExecute('antigravity'), false);

  // Step 3: Operator performs manual reset with audit metadata
  const resetRes = guard.resetCircuit('antigravity', {
    reset_by: 'operator-alice',
    reason: 'TOS appeal approved and token refreshed by admin',
  });
  assert.strictEqual(resetRes.state, 'CLOSED');
  assert.strictEqual(resetRes.reset_by, 'operator-alice');
  assert.strictEqual(resetRes.reason, 'TOS appeal approved and token refreshed by admin');
  assert.ok(resetRes.reset_time, 'reset_time must be recorded');

  // Verify persistence to state file
  const persistedState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.strictEqual(persistedState.antigravity.state, 'CLOSED');
  assert.strictEqual(persistedState.antigravity.last_reset.reset_by, 'operator-alice');
  assert.strictEqual(persistedState.antigravity.last_reset.reason, 'TOS appeal approved and token refreshed by admin');
  assert.strictEqual(persistedState.antigravity.last_reset.reset_time, resetRes.reset_time);

  // Step 4: After reset, verify normal launch is permitted and succeeds
  assert.strictEqual(guard.canExecute('antigravity'), true);

  const task2Id = 'TASK-RT-E-ALLOWED';
  const task2 = {
    task_id: task2Id,
    goal: 'launch after manual reset',
    acceptance: 'test',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: dir,
    author_executor: 'antigravity',
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 1,
    red_lines: [],
    review_rules: [],
    state: 'CREATED',
    runs: [],
  };
  saveTaskAtomic(join(tasksDir, `${task2Id}.json`), task2);
  sched.enqueue(task2);
  sched.runNext();
  await sched.waitAll();

  const finalTask2 = readTaskFile(join(tasksDir, `${task2Id}.json`));
  assert.strictEqual(finalTask2.state, 'COMPLETED');
  assert.strictEqual(agyRuns, 1, 'antigravity executor should execute successfully after reset');

  rmSync(dir, { recursive: true, force: true });
});

test('Runtime-F: burst launch protection: 10 concurrent requests serialize with peak active process <= 1', async () => {
  const dir = tmpDir('af-rt-f-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
  }));
  writeFileSync(stateFile, JSON.stringify({})); // clean

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile });

  let concurrentProcesses = 0;
  let maxObservedConcurrent = 0;
  const launchOrder = [];
  const finishOrder = [];

  const TOTAL_TASKS = 10;
  const TASK_DURATION_MS = 25;

  async function simulateTask(idx) {
    await guard.acquireSlot('antigravity');
    launchOrder.push(idx);
    try {
      concurrentProcesses += 1;
      if (concurrentProcesses > maxObservedConcurrent) {
        maxObservedConcurrent = concurrentProcesses;
      }
      // Assert at every moment that active concurrency never exceeds max_parallel (1)
      assert.ok(concurrentProcesses <= 1, `Concurrent processes (${concurrentProcesses}) exceeded max_parallel (1)`);
      await new Promise((r) => setTimeout(r, TASK_DURATION_MS));
    } finally {
      concurrentProcesses -= 1;
      finishOrder.push(idx);
      guard.releaseSlot('antigravity');
    }
  }

  const startTime = Date.now();
  // Fire all 10 tasks concurrently
  await Promise.all(Array.from({ length: TOTAL_TASKS }, (_, i) => simulateTask(i)));
  const totalElapsed = Date.now() - startTime;

  // Assertions:
  // 1. Peak concurrency was strictly 1
  assert.strictEqual(maxObservedConcurrent, 1, 'peak concurrent processes must be strictly <= 1');
  // 2. All 10 tasks completed
  assert.strictEqual(launchOrder.length, TOTAL_TASKS, 'all 10 tasks must be launched');
  assert.strictEqual(finishOrder.length, TOTAL_TASKS, 'all 10 tasks must be finished');
  assert.strictEqual(concurrentProcesses, 0, 'all active processes released');
  // 3. Serialized execution duration: must be at least TOTAL_TASKS * TASK_DURATION_MS
  // (10 * 25ms = 250ms), proving strict sequential execution and no parallel burst
  assert.ok(totalElapsed >= TOTAL_TASKS * TASK_DURATION_MS * 0.8, `Elapsed time (${totalElapsed}ms) indicates tasks were serialized, not burst in parallel`);

  rmSync(dir, { recursive: true, force: true });
});

test('Runtime-G: detectThinkingDeadLoop detects single repeat and cycle patterns', () => {
  // Normal non-looping progress
  const normal = ['cmd:ls', 'cmd:cat', 'file:src/app.mjs', 'cmd:npm test'];
  assert.strictEqual(detectThinkingDeadLoop(normal), null);

  // Single action repeated 4+ times
  const repeat = ['cmd:ls', 'cmd:npm test', 'cmd:npm test', 'cmd:npm test', 'cmd:npm test'];
  const resRepeat = detectThinkingDeadLoop(repeat);
  assert.ok(resRepeat?.detected, 'should detect repeated action');
  assert.match(resRepeat.reason, /Repeated action 4 times: cmd:npm test/);

  // Repeating cycle of length 2 (A -> B -> A -> B -> A -> B -> A -> B)
  const cycle2 = ['cmd:a', 'cmd:b', 'cmd:a', 'cmd:b', 'cmd:a', 'cmd:b', 'cmd:a', 'cmd:b'];
  const resCycle2 = detectThinkingDeadLoop(cycle2);
  assert.ok(resCycle2?.detected, 'should detect cycle length 2');
  assert.match(resCycle2.reason, /Repeating cycle \(len 2\)/);

  // Empty or short history
  assert.strictEqual(detectThinkingDeadLoop([]), null);
  assert.strictEqual(detectThinkingDeadLoop(['cmd:a', 'cmd:b']), null);

  // Consecutive file changes (normal coding) must NEVER trigger dead loop
  const fileEdits = ['file:src/schema.mjs', 'file:src/schema.mjs', 'file:src/schema.mjs', 'file:src/schema.mjs'];
  assert.strictEqual(detectThinkingDeadLoop(fileEdits), null, 'file edits must not trigger thinking dead loop');
});
