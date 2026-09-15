// tests/executor-error-classifier.test.mjs - PHASE 5-A error classification
//
// Covers the stdout blind spot: some executors report failures on stdout and
// keep stderr empty (codex runs with --json and emits JSON Lines there), so an
// account/ToS refusal must not be downgraded to a retryable transient fault
// just because of where the evidence arrived.
//
//   EC-1: 403 on stdout only -> ACCOUNT_POLICY, fail-closed
//   EC-2: 403 on stderr      -> ACCOUNT_POLICY, fail-closed (unchanged)
//   EC-3: TOS_VIOLATION on stdout -> ACCOUNT_POLICY, fail-closed
//   EC-4: 429 on stdout      -> RATE_LIMIT, cooldown (unchanged)
//   EC-5: 401 on stdout      -> AUTH_FAILURE, fail-closed
//   EC-6: a workspace test log mentioning 403 must stay non-fatal
//   EC-7: end-to-end: a launcher reporting the refusal on stdout trips the
//         breaker and the task fails closed without retry or fallback

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './helpers/runtime-state-fixture.mjs';
import './helpers/executors-fixture.mjs';
import { classifyExecutionError } from '../lib/executor-error-classifier.mjs';
import { runtimeGuard } from '../lib/executor-runtime-guard.mjs';
import { ClineAdapter } from '../lib/adapters.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { POLICY_DENIAL_STUB } from './helpers/executor-stub-launcher.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ------------------------------------------------------------------ EC-1
test('EC-1: 403 只出现在 stdout 时同样 fail-closed', () => {
  const cls = classifyExecutionError('codex', {
    exit_code: 1,
    stdout: '{"type":"error","message":"unexpected status 403 Forbidden: account suspended"}',
    stderr: '',
  });

  assert.strictEqual(cls.category, 'ACCOUNT_POLICY');
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.safety_action, 'OPEN_MANUAL_RESET');
});

// ------------------------------------------------------------------ EC-2
test('EC-2: 403 出现在 stderr 时维持原语义', () => {
  const cls = classifyExecutionError('codex', {
    exit_code: 1,
    stdout: '',
    stderr: '403 PERMISSION_DENIED: service disabled for TOS_VIOLATION',
  });

  assert.strictEqual(cls.category, 'ACCOUNT_POLICY');
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.safety_action, 'OPEN_MANUAL_RESET');
});

// ------------------------------------------------------------------ EC-3
test('EC-3: TOS_VIOLATION 出现在 stdout 时 fail-closed', () => {
  const cls = classifyExecutionError('codex', {
    exit_code: 1,
    stdout: '{"type":"error","message":"Terms of Service violation detected"}',
    stderr: '',
  });

  assert.strictEqual(cls.category, 'ACCOUNT_POLICY');
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.safety_action, 'OPEN_MANUAL_RESET');
});

// ------------------------------------------------------------------ EC-4
test('EC-4: 429 出现在 stdout 时维持 RATE_LIMIT 冷却语义', () => {
  const cls = classifyExecutionError('codex', {
    exit_code: 1,
    stdout: '{"type":"error","message":"provider returned 429 too many requests"}',
    stderr: '',
  });

  assert.strictEqual(cls.category, 'RATE_LIMIT');
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.safety_action, 'COOLDOWN');
});

// ------------------------------------------------------------------ EC-5
test('EC-5: 401 出现在 stdout 时 fail-closed', () => {
  const cls = classifyExecutionError('codex', {
    exit_code: 1,
    stdout: '{"type":"error","message":"401 unauthorized: token expired"}',
    stderr: '',
  });

  assert.strictEqual(cls.category, 'AUTH_FAILURE');
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.safety_action, 'OPEN_MANUAL_RESET');
});

// ------------------------------------------------------------------ EC-6
test('EC-6: 目标仓库测试日志里的 403 不得触发熔断', () => {
  // A workspace test log that merely mentions a 403 is not a provider refusal.
  const cls = classifyExecutionError('codex', {
    exit_code: 1,
    stdout: '✔ 403 retries with Retry-After and then succeeds\n✖ test/features/auth.test.mjs (1 of 12 failed)',
    stderr: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
  });

  assert.notStrictEqual(cls.category, 'ACCOUNT_POLICY');
  assert.strictEqual(cls.category, 'TRANSIENT_FAULT');
  assert.strictEqual(cls.retryable, true);
});

// ------------------------------------------------------------------ EC-7
test('EC-7: 端到端 - launcher 在 stdout 报 403 → 熔断 OPEN_MANUAL_RESET、任务不重试不回退', async () => {
  const work = tmpDir('af-ec7-');
  const blockedDir = tmpDir('af-ec7-blocked-');
  const schedDir = tmpDir('af-ec7-sched-');
  const previousLauncher = process.env.CLINE_LAUNCHER;
  process.env.CLINE_LAUNCHER = POLICY_DENIAL_STUB;

  try {
    // 1. The adapter must surface the refusal, not a transient fault.
    const result = await ClineAdapter.run({
      task_id: 'TASK-EC7',
      assigned_role: 'author',
      prompt: 'trigger provider refusal',
      cwd: work,
      timeout_ms: 15000,
    });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.error_classification?.category, 'ACCOUNT_POLICY');
    assert.strictEqual(result.error_classification?.retryable, false);

    // 2. The default guard must have opened the breaker for that executor.
    assert.strictEqual(runtimeGuard.getCircuitState('cline').state, 'OPEN_MANUAL_RESET');
    assert.strictEqual(runtimeGuard.canExecute('cline'), false);

    // 3. While the breaker is open no launch is attempted at all (fail-closed).
    const blockedSched = new Scheduler({ tasksDir: blockedDir, adapters: { cline: ClineAdapter } });
    blockedSched.enqueue({
      task_id: 'TASK-EC7-BLOCKED',
      goal: 'must not launch while the breaker is open',
      acceptance: 'exit 0',
      fixture_dir: blockedDir,
      author_executor: 'cline',
      reviewer_executor: 'cline',
    });
    blockedSched.runNext();
    await blockedSched.waitAll();
    const blocked = JSON.parse(readFileSync(join(blockedDir, 'TASK-EC7-BLOCKED.json'), 'utf8'));
    assert.strictEqual(blocked.state, 'FAILED');
    assert.strictEqual(blocked.runs.length, 0, 'the open breaker must prevent the launch entirely');

    // 4. With the breaker cleared, a policy refusal DURING a run must fail the
    //    task closed: one attempt, no bounded retry, no fallback executor.
    runtimeGuard.resetCircuit('cline', { reset_by: 'test', reason: 'EC-7 continued' });
    const sched = new Scheduler({ tasksDir: schedDir, adapters: { cline: ClineAdapter } });
    sched.enqueue({
      task_id: 'TASK-EC7-SCHED',
      goal: 'fail closed on stdout 403',
      acceptance: 'exit 0',
      fixture_dir: schedDir,
      author_executor: 'cline',
      reviewer_executor: 'cline',
    });

    sched.runNext();
    await sched.waitAll();

    const task = JSON.parse(readFileSync(join(schedDir, 'TASK-EC7-SCHED.json'), 'utf8'));

    assert.strictEqual(task.state, 'FAILED', 'an account/policy refusal must fail the task');
    assert.strictEqual(task.runs.length, 1, 'a policy refusal must never be retried');
    assert.strictEqual(task.author_executor, 'cline', 'a policy refusal must never fall back to another executor');
    assert.strictEqual(task.error_classification?.category, 'ACCOUNT_POLICY');
    assert.strictEqual(runtimeGuard.getCircuitState('cline').state, 'OPEN_MANUAL_RESET');
  } finally {
    if (previousLauncher === undefined) delete process.env.CLINE_LAUNCHER;
    else process.env.CLINE_LAUNCHER = previousLauncher;
    for (const dir of [work, blockedDir, schedDir]) rmSync(dir, { recursive: true, force: true });
  }
});
