// executor-router.test.mjs - PHASE 6-C Multi Executor Routing tests
//
// Test Matrix:
//   6C-1: Capability Filter (requires_mcp excludes codex)
//   6C-2: Availability Filter (UNAVAILABLE excludes antigravity)
//   6C-3: Runtime Filter (OPEN_MANUAL_RESET / PROBING / active cooldown excluded)
//   6C-4: Deterministic Priority Sort (default priority order verification)
//   6C-5: ROLE != PLATFORM (same executor can serve as author and reviewer)
//   6C-6: Fallback on TRANSIENT_FAULT / RATE_LIMIT (scheduler falls back to next candidate)
//   6C-7: No Fallback on ACCOUNT_POLICY (fail closed, zero fallback)
//   6C-8: Executor Isolation (no session ref or run ID leakage between executors)

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import './helpers/executors-fixture.mjs';
import {
  resolveExecutorRoute,
  loadCapabilityMap,
  DEFAULT_PRIORITY_ORDER,
} from '../lib/executor-router.mjs';
import './helpers/acceptance-allowlist.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { classifyExecutionError } from '../lib/executor-error-classifier.mjs';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';
import { readTaskFile, saveTaskAtomic } from '../lib/store.mjs';

function tmpDir(prefix = 'af-p6c-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeScriptedFake(type, script) {
  let callCount = 0;
  return {
    type,
    schedulable: true,
    supportsMcpUnattended: type !== 'codex',
    calls: [],
    async run(capsule) {
      callCount += 1;
      const idx = Math.min(callCount - 1, script.length - 1);
      const res = script[idx];
      const out = typeof res === 'function' ? await res(capsule, callCount) : res;
      this.calls.push({ method: 'run', capsule, out });
      return out;
    },
    async resume(sessionRef, capsule) {
      callCount += 1;
      const idx = Math.min(callCount - 1, script.length - 1);
      const res = script[idx];
      const out = typeof res === 'function' ? await res(capsule, callCount) : res;
      this.calls.push({ method: 'resume', sessionRef, capsule, out });
      return out;
    },
    cancel() { return { cancelled: true }; },
  };
}

const PASS_REVIEW = {
  decision: 'PASS',
  summary: 'All criteria verified and accepted',
  issues: [],
  required_changes: [],
  evidence: ['test ok'],
};

function makePassReview(type, sessionRef) {
  return {
    executor_run_id: `RUN-REV-${randomUUID().slice(0, 6)}`,
    executor_type: type,
    assigned_role: 'reviewer',
    status: 'completed',
    session_ref: sessionRef,
    structured_result: {
      result: '```json\n' + JSON.stringify(PASS_REVIEW) + '\n```',
    },
    exit_code: 0,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    error: null,
    error_classification: { category: 'SUCCESS', retryable: false, safety_action: 'NONE', reason: null },
  };
}

// ------------------------------------------------------------------ 6C-1
test('6C-1: Capability Filter (requires_mcp excludes blocked executors, permits PASS executors)', () => {
  // 1. Synthetic capability map test: executor with mcp_unattended: 'BLOCKED' is excluded
  const blockedCapMap = new Map([
    ['vertex-gemini', { capabilities_audit: { mcp_unattended: 'PASS' } }],
    ['claude', { capabilities_audit: { mcp_unattended: 'PASS' } }],
    ['blocked-exec', { capabilities_audit: { mcp_unattended: 'BLOCKED' } }],
  ]);
  const route = resolveExecutorRoute({ requires_mcp: true }, {
    priorityOrder: ['vertex-gemini', 'claude', 'blocked-exec'],
    capabilityMap: blockedCapMap,
  });
  assert.notStrictEqual(route.primary, 'blocked-exec', 'blocked-exec must not be primary when requires_mcp is true');
  assert.ok(!route.fallbacks.includes('blocked-exec'), 'blocked-exec must not be in fallbacks when requires_mcp is true');
  assert.strictEqual(route.primary, 'vertex-gemini');

  // 2. Explicit preference for blocked executor with requires_mcp: true must fail closed (primary: null)
  const explicitBlocked = resolveExecutorRoute({ requires_mcp: true, author_executor: 'blocked-exec' }, {
    capabilityMap: blockedCapMap,
  });
  assert.strictEqual(explicitBlocked.primary, null, 'explicit blocked preference with requires_mcp must return primary null');
  assert.ok(!explicitBlocked.fallbacks.includes('blocked-exec'), 'blocked executor must not appear in eligible fallbacks');

  // 3. Normal task without requires_mcp with explicit preference succeeds
  const normalRoute = resolveExecutorRoute({ requires_mcp: false, author_executor: 'blocked-exec' }, {
    capabilityMap: blockedCapMap,
  });
  assert.strictEqual(normalRoute.primary, 'blocked-exec', 'blocked-exec can be selected when requires_mcp is false');

  // 4. Codex (audited READY on 0.153.4) satisfies requires_mcp
  const codexMcp = resolveExecutorRoute({ requires_mcp: true, author_executor: 'codex' });
  assert.strictEqual(codexMcp.primary, 'codex', 'codex satisfies requires_mcp on 0.153.4');

  // 5. Enterprise compliance constraint
  const entRoute = resolveExecutorRoute({ compliance: 'enterprise' });
  assert.strictEqual(entRoute.primary, 'vertex-gemini', 'enterprise compliance selects vertex-gemini');
  assert.ok(!entRoute.fallbacks.includes('claude'), 'claude is not cloud-enterprise');
});

// ------------------------------------------------------------------ 6C-2
test('6C-2: Availability Filter (UNAVAILABLE excludes antigravity)', () => {
  // 1. Antigravity has canonical availability_status = UNAVAILABLE (403 TOS_VIOLATION)
  const route = resolveExecutorRoute({});
  assert.notStrictEqual(route.primary, 'antigravity', 'antigravity must never be selected when UNAVAILABLE');
  assert.ok(!route.fallbacks.includes('antigravity'), 'antigravity must not be in fallbacks when UNAVAILABLE');

  // 2. Explicit request for antigravity must fail closed (primary: null)
  const explicitAgy = resolveExecutorRoute({ author_executor: 'antigravity' });
  assert.strictEqual(explicitAgy.primary, null, 'explicit antigravity preference must return primary null');

  // 3. Synthetic availability map test
  const syntheticAvails = new Map([
    ['vertex-gemini', { availability_status: 'UNAVAILABLE', reason: 'maintenance' }],
    ['claude', { availability_status: 'AVAILABLE', reason: null }],
  ]);
  const syntheticRoute = resolveExecutorRoute({}, { availabilityMap: syntheticAvails });
  assert.strictEqual(syntheticRoute.primary, 'claude', 'vertex-gemini excluded when marked UNAVAILABLE');
});

// ------------------------------------------------------------------ 6C-3
test('6C-3: Runtime Filter (OPEN_MANUAL_RESET / PROBING / active cooldown excluded)', () => {
  // 1. OPEN_MANUAL_RESET exclusion
  const guardOpen = {
    canExecute(id) { return id !== 'vertex-gemini'; },
    getCircuitState(id) {
      return id === 'vertex-gemini'
        ? { state: 'OPEN_MANUAL_RESET', reason: '403 TOS_VIOLATION' }
        : { state: 'CLOSED' };
    },
  };
  const routeOpen = resolveExecutorRoute({}, { runtimeGuard: guardOpen });
  assert.strictEqual(routeOpen.primary, 'claude', 'vertex-gemini excluded due to OPEN_MANUAL_RESET');
  assert.ok(!routeOpen.fallbacks.includes('vertex-gemini'));

  // 2. PROBING state exclusion
  const guardProbing = {
    canExecute(id) { return id !== 'claude'; },
    getCircuitState(id) {
      return id === 'claude'
        ? { state: 'PROBING', reason: 'recovery probe in flight' }
        : { state: 'CLOSED' };
    },
  };
  const routeProbing = resolveExecutorRoute({}, {
    priorityOrder: ['claude', 'vertex-gemini'],
    runtimeGuard: guardProbing,
  });
  assert.strictEqual(routeProbing.primary, 'vertex-gemini', 'claude excluded while in PROBING');

  // 3. Active cooldown exclusion
  const now = Date.now();
  const guardCooldown = {
    now: () => now,
    getCircuitState(id) {
      return id === 'vertex-gemini'
        ? { state: 'OPEN_COOLDOWN', cooldown_until: now + 30000, reason: '429 rate limit' }
        : { state: 'CLOSED' };
    },
  };
  const routeCooldown = resolveExecutorRoute({}, { runtimeGuard: guardCooldown });
  assert.strictEqual(routeCooldown.primary, 'claude', 'vertex-gemini excluded while under active cooldown');
});

// ------------------------------------------------------------------ 6C-4
test('6C-4: Deterministic Priority Sort (default priority order verification)', () => {
  // Default priority: vertex-gemini -> claude -> codex -> antigravity
  assert.deepStrictEqual(DEFAULT_PRIORITY_ORDER, [
    'vertex-gemini',
    'claude',
    'codex',
    'antigravity',
  ]);

  const route1 = resolveExecutorRoute({});
  const route2 = resolveExecutorRoute({});
  assert.deepStrictEqual(route1, route2, 'routing must be strictly deterministic');
  assert.strictEqual(route1.primary, 'vertex-gemini');
  assert.deepStrictEqual(route1.fallbacks, ['claude', 'codex']);

  // Custom priority order
  const customRoute = resolveExecutorRoute({}, {
    priorityOrder: ['codex', 'claude', 'vertex-gemini'],
  });
  assert.strictEqual(customRoute.primary, 'codex');
  assert.deepStrictEqual(customRoute.fallbacks, ['claude', 'vertex-gemini']);
});

// ------------------------------------------------------------------ 6C-5
test('6C-5: ROLE != PLATFORM (same executor can serve as author and reviewer)', async () => {
  // 1. Router check: no platform-role coupling
  const authorRoute = resolveExecutorRoute({}, { role: 'author' });
  const reviewerRoute = resolveExecutorRoute({}, { role: 'reviewer' });
  assert.strictEqual(authorRoute.primary, 'vertex-gemini');
  assert.strictEqual(reviewerRoute.primary, 'vertex-gemini');

  // 2. Execution check: same platform used for both roles with distinct agent instances
  const dir = tmpDir('af-6c-5-');
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  const vertexFake = makeScriptedFake('vertex-gemini', [
    // Author run
    (capsule) => {
      assert.strictEqual(capsule.assigned_role, 'author');
      return {
        executor_run_id: `RUN-AUTH-${randomUUID().slice(0, 6)}`,
        executor_type: 'vertex-gemini',
        assigned_role: 'author',
        status: 'completed',
        session_ref: 'SESS-AUTH-VG',
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
        error_classification: { category: 'SUCCESS', retryable: false, safety_action: 'NONE', reason: null },
      };
    },
    // Reviewer run
    (capsule) => {
      assert.strictEqual(capsule.assigned_role, 'reviewer');
      return makePassReview('vertex-gemini', 'SESS-REV-VG');
    },
  ]);

  const sched = new Scheduler({
    maxConcurrent: 1,
    tasksDir,
    adapters: { 'vertex-gemini': vertexFake },
  });

  const taskId = 'TASK-6C-5';
  const task = {
    task_id: taskId,
    state: 'CREATED',
    goal: 'verify ROLE != PLATFORM',
    acceptance: 'test',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: dir,
    author_executor: 'vertex-gemini',
    reviewer_executor: 'vertex-gemini',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 3,
    red_lines: [],
    review_rules: [],
    runs: [],
  };
  saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);

  sched.enqueue(task);
  sched.runNext();
  await sched.waitAll();

  const finalTask = readTaskFile(join(tasksDir, `${taskId}.json`));
  assert.strictEqual(finalTask.state, 'COMPLETED');
  assert.strictEqual(vertexFake.calls.length, 2);
  assert.strictEqual(vertexFake.calls[0].capsule.assigned_role, 'author');
  assert.strictEqual(vertexFake.calls[1].capsule.assigned_role, 'reviewer');

  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 6C-6
test('6C-6: Fallback on TRANSIENT_FAULT / RATE_LIMIT (scheduler falls back to next candidate)', async () => {
  // Test 6C-6a: Fallback on RATE_LIMIT
  {
    const dir = tmpDir('af-6c-6a-');
    const tasksDir = join(dir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });

    let vertexCalls = 0;
    const vertexFake = makeScriptedFake('vertex-gemini', [
      () => {
        vertexCalls += 1;
        const errCls = classifyExecutionError('vertex-gemini', {
          exit_code: 1,
          stderr: '429 RESOURCE_EXHAUSTED: Rate limit exceeded for model gemini-1.5-pro',
        });
        assert.strictEqual(errCls.category, 'RATE_LIMIT');
        return {
          executor_run_id: `RUN-VG-FAIL-${randomUUID().slice(0, 6)}`,
          executor_type: 'vertex-gemini',
          assigned_role: 'author',
          status: 'failed',
          session_ref: null,
          exit_code: 1,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: '429 RESOURCE_EXHAUSTED',
          error_classification: errCls,
        };
      },
    ]);

    let claudeAuthorCalls = 0;
    const claudeFake = makeScriptedFake('claude', [
      // Claude author (fallback)
      () => {
        claudeAuthorCalls += 1;
        return {
          executor_run_id: `RUN-CL-AUTH-${randomUUID().slice(0, 6)}`,
          executor_type: 'claude',
          assigned_role: 'author',
          status: 'completed',
          session_ref: 'SESS-CLAUDE-AUTH',
          exit_code: 0,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: null,
          error_classification: { category: 'SUCCESS', retryable: false, safety_action: 'NONE', reason: null },
        };
      },
      // Claude reviewer
      () => makePassReview('claude', 'SESS-CLAUDE-REV'),
    ]);

    const sched = new Scheduler({
      maxConcurrent: 1,
      maxExecutorRetries: 1,
      tasksDir,
      adapters: {
        'vertex-gemini': vertexFake,
        claude: claudeFake,
      },
    });

    const taskId = 'TASK-6C-6A';
    const task = {
      task_id: taskId,
      state: 'CREATED',
      goal: 'test rate limit fallback',
      acceptance: 'test',
      acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
      fixture_dir: dir,
      author_executor: 'auto', // Router will assign primary: vertex-gemini, fallbacks: [claude]
      reviewer_executor: 'claude',
      author_role: 'author',
      reviewer_role: 'reviewer',
      max_revisions: 3,
      red_lines: [],
      review_rules: [],
      runs: [],
    };
    saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);

    sched.enqueue(task);
    sched.runNext();
    await sched.waitAll();

    const finalTask = readTaskFile(join(tasksDir, `${taskId}.json`));
    assert.strictEqual(finalTask.state, 'COMPLETED', `Task should complete via fallback: ${finalTask.failure_reason}`);
    assert.strictEqual(finalTask.author_executor, 'claude', 'author_executor should be updated to fallback executor');
    assert.strictEqual(vertexCalls, 1, 'vertex-gemini hit 429 and was NOT retried (RATE_LIMIT not retryable on same executor)');
    assert.strictEqual(claudeAuthorCalls, 1, 'claude took over execution as fallback');

    const fallbackEvents = sched.events.filter((e) => e.kind === 'executor_fallback');
    assert.strictEqual(fallbackEvents.length, 1);
    assert.strictEqual(fallbackEvents[0].from, 'vertex-gemini');
    assert.strictEqual(fallbackEvents[0].to, 'claude');
    assert.strictEqual(fallbackEvents[0].category, 'RATE_LIMIT');

    rmSync(dir, { recursive: true, force: true });
  }

  // Test 6C-6b: Fallback on TRANSIENT_FAULT after bounded retry
  {
    const dir = tmpDir('af-6c-6b-');
    const tasksDir = join(dir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });

    let vertexCalls = 0;
    const vertexFake = makeScriptedFake('vertex-gemini', [
      () => {
        vertexCalls += 1;
        const errCls = classifyExecutionError('vertex-gemini', {
          exit_code: 1,
          stderr: 'socket hang up',
        });
        assert.strictEqual(errCls.category, 'TRANSIENT_FAULT');
        return {
          executor_run_id: `RUN-VG-CRASH-${vertexCalls}`,
          executor_type: 'vertex-gemini',
          assigned_role: 'author',
          status: 'failed',
          session_ref: null,
          exit_code: 1,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: 'socket hang up',
          error_classification: errCls,
        };
      },
    ]);

    let claudeAuthorCalls = 0;
    const claudeFake = makeScriptedFake('claude', [
      () => {
        claudeAuthorCalls += 1;
        return {
          executor_run_id: `RUN-CL-AUTH-${randomUUID().slice(0, 6)}`,
          executor_type: 'claude',
          assigned_role: 'author',
          status: 'completed',
          session_ref: 'SESS-CLAUDE-AUTH',
          exit_code: 0,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: null,
          error_classification: { category: 'SUCCESS', retryable: false, safety_action: 'NONE', reason: null },
        };
      },
      () => makePassReview('claude', 'SESS-CLAUDE-REV'),
    ]);

    const sched = new Scheduler({
      maxConcurrent: 1,
      maxExecutorRetries: 1, // 1 initial + 1 retry on vertex before fallback
      tasksDir,
      adapters: {
        'vertex-gemini': vertexFake,
        claude: claudeFake,
      },
    });

    const taskId = 'TASK-6C-6B';
    const task = {
      task_id: taskId,
      state: 'CREATED',
      goal: 'test transient fault fallback',
      acceptance: 'test',
      acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
      fixture_dir: dir,
      author_executor: 'auto',
      reviewer_executor: 'claude',
      author_role: 'author',
      reviewer_role: 'reviewer',
      max_revisions: 3,
      red_lines: [],
      review_rules: [],
      runs: [],
    };
    saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);

    sched.enqueue(task);
    sched.runNext();
    await sched.waitAll();

    const finalTask = readTaskFile(join(tasksDir, `${taskId}.json`));
    assert.strictEqual(finalTask.state, 'COMPLETED');
    assert.strictEqual(finalTask.author_executor, 'claude');
    assert.strictEqual(vertexCalls, 2, 'vertex-gemini called twice (initial + 1 bounded retry)');
    assert.strictEqual(claudeAuthorCalls, 1, 'claude took over after vertex exhausted retries');

    const retryEvents = sched.events.filter((e) => e.kind === 'executor_retry');
    assert.strictEqual(retryEvents.length, 1);
    const fallbackEvents = sched.events.filter((e) => e.kind === 'executor_fallback');
    assert.strictEqual(fallbackEvents.length, 1);
    assert.strictEqual(fallbackEvents[0].from, 'vertex-gemini');
    assert.strictEqual(fallbackEvents[0].to, 'claude');

    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 6C-7
test('6C-7: No Fallback on ACCOUNT_POLICY (fail closed, zero fallback)', async () => {
  const dir = tmpDir('af-6c-7-');
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  let vertexCalls = 0;
  const vertexFake = makeScriptedFake('vertex-gemini', [
    () => {
      vertexCalls += 1;
      const errCls = classifyExecutionError('vertex-gemini', {
        exit_code: 1,
        stderr: '403 PERMISSION_DENIED: Service disabled for TOS_VIOLATION',
      });
      assert.strictEqual(errCls.category, 'ACCOUNT_POLICY');
      return {
        executor_run_id: `RUN-VG-403-${randomUUID().slice(0, 6)}`,
        executor_type: 'vertex-gemini',
        assigned_role: 'author',
        status: 'failed',
        session_ref: null,
        exit_code: 1,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: '403 TOS_VIOLATION',
        error_classification: errCls,
      };
    },
  ]);

  const claudeFake = makeScriptedFake('claude', []);

  const sched = new Scheduler({
    maxConcurrent: 1,
    maxExecutorRetries: 2,
    tasksDir,
    adapters: {
      'vertex-gemini': vertexFake,
      claude: claudeFake,
    },
  });

  const taskId = 'TASK-6C-7';
  const task = {
    task_id: taskId,
    state: 'CREATED',
    goal: 'verify fail closed on 403',
    acceptance: 'test',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: dir,
    author_executor: 'auto', // primary: vertex-gemini, fallbacks: [claude]
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 3,
    red_lines: [],
    review_rules: [],
    runs: [],
  };
  saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);

  sched.enqueue(task);
  sched.runNext();
  await sched.waitAll();

  const finalTask = readTaskFile(join(tasksDir, `${taskId}.json`));
  assert.strictEqual(finalTask.state, 'FAILED', 'Task must fail closed on ACCOUNT_POLICY');
  assert.strictEqual(finalTask.error_classification?.category, 'ACCOUNT_POLICY');
  assert.strictEqual(vertexCalls, 1, '403 must be called exactly once (no retry)');
  assert.strictEqual(claudeFake.calls.length, 0, 'Secondary executor must NEVER be called on ACCOUNT_POLICY');

  const forbiddenEvents = sched.events.filter((e) => e.kind === 'fallback_forbidden');
  assert.strictEqual(forbiddenEvents.length, 1, 'fallback_forbidden event must be emitted');
  assert.strictEqual(forbiddenEvents[0].category, 'ACCOUNT_POLICY');

  const fallbackEvents = sched.events.filter((e) => e.kind === 'executor_fallback');
  assert.strictEqual(fallbackEvents.length, 0, 'Zero fallback events permitted');

  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 6C-8
test('6C-8: Executor Isolation (no session ref or run ID leakage between executors)', async () => {
  const dir = tmpDir('af-6c-8-');
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  const vertexRunId = 'RUN-VERTEX-ISOLATED-01';
  const vertexSessionRef = 'SESS-VG-POLLUTED-ABC';
  const claudeRunId = 'RUN-CLAUDE-ISOLATED-02';
  const claudeSessionRef = 'SESS-CLAUDE-CLEAN-XYZ';

  const vertexFake = makeScriptedFake('vertex-gemini', [
    () => {
      const errCls = classifyExecutionError('vertex-gemini', {
        exit_code: 1,
        stderr: '429 Rate limit exceeded',
      });
      return {
        executor_run_id: vertexRunId,
        executor_type: 'vertex-gemini',
        assigned_role: 'author',
        status: 'failed',
        session_ref: vertexSessionRef, // Simulated partial run that acquired a session before 429
        exit_code: 1,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: '429 Rate limit exceeded',
        error_classification: errCls,
      };
    },
  ]);

  let claudeReceivedSession = 'NOT_SET';
  const claudeFake = makeScriptedFake('claude', [
    (capsule) => {
      // Check whether session was leaked to the fallback executor
      claudeReceivedSession = capsule.session_ref ?? null;
      return {
        executor_run_id: claudeRunId,
        executor_type: 'claude',
        assigned_role: 'author',
        status: 'completed',
        session_ref: claudeSessionRef,
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
        error_classification: { category: 'SUCCESS', retryable: false, safety_action: 'NONE', reason: null },
      };
    },
    () => makePassReview('claude', 'SESS-CL-REV'),
  ]);

  const sched = new Scheduler({
    maxConcurrent: 1,
    maxExecutorRetries: 0,
    tasksDir,
    adapters: {
      'vertex-gemini': vertexFake,
      claude: claudeFake,
    },
  });

  const taskId = 'TASK-6C-8';
  const task = {
    task_id: taskId,
    state: 'CREATED',
    goal: 'verify executor isolation',
    acceptance: 'test',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: dir,
    author_executor: 'auto',
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 3,
    red_lines: [],
    review_rules: [],
    runs: [],
  };
  saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);

  sched.enqueue(task);
  sched.runNext();
  await sched.waitAll();

  const finalTask = readTaskFile(join(tasksDir, `${taskId}.json`));
  assert.strictEqual(finalTask.state, 'COMPLETED');

  // Isolation assertions:
  // 1. Fallback executor must start cleanly: capsule session_ref received must be null
  assert.strictEqual(claudeReceivedSession, null, 'Fallback executor must NOT inherit the failed executor session');

  // 2. Final task state must point to the fallback executor and its clean session
  assert.strictEqual(finalTask.author_executor, 'claude');
  assert.strictEqual(finalTask.author_session_ref, claudeSessionRef);
  assert.strictEqual(finalTask.author_session_executor_type, 'claude');

  // 3. Task runs must isolate identities: vertex run ID != claude run ID
  const authorRuns = finalTask.runs.filter((r) => r.assigned_role === 'author');
  assert.strictEqual(authorRuns.length, 2, 'Both author runs recorded in task audit trail');
  assert.strictEqual(authorRuns[0].executor_type, 'vertex-gemini');
  assert.strictEqual(authorRuns[1].executor_type, 'claude');
  assert.ok(authorRuns[0].executor_run_id.startsWith('RUN-'));
  assert.ok(authorRuns[1].executor_run_id.startsWith('RUN-'));
  assert.notStrictEqual(authorRuns[0].executor_run_id, authorRuns[1].executor_run_id, 'Run IDs must be distinct and non-colliding');

  rmSync(dir, { recursive: true, force: true });
});
