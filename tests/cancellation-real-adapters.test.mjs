// tests/cancellation-real-adapters.test.mjs - precise cancellation across the
// real codex / claude / antigravity adapters.
//
// These three adapters used to cancel through terminateRun(), which never wrote
// the cancel marker. The run therefore came back as a RETRYABLE
// TRANSIENT_FAULT: the task could be FAILED-overwritten after the operator had
// already recorded CANCELLED, and the scheduler could re-run a cancelled task.
//
//   CANCEL-codex / CANCEL-claude / CANCEL-antigravity:
//     a live run is cancelled precisely by executor_run_id and reports
//     cancelled evidence + a non-retryable run result.
//   CANCEL-scheduler: cancelling a running task writes CANCELLED and does not
//     grow the run history or get overwritten by the unwinding run.

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import './helpers/runtime-state-fixture.mjs';
import './helpers/executors-fixture.mjs';
import './helpers/executor-hang-stub-env.mjs';
import { RUNS_DIR } from '../lib/config.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { CodexAdapter, AntigravityAdapter, ClaudeAdapter } from '../lib/adapters.mjs';



function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// The adapters persist a durable run handle once the process is up; waiting for
// it is the deterministic "the run is live" signal.
async function waitForRunHandle(runId, timeoutMs = 8000) {
  const handleFile = join(RUNS_DIR, `${runId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(handleFile)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run handle was never written for ${runId}`);
}

const ADAPTER_CASES = [
  { name: 'codex', adapter: CodexAdapter },
  { name: 'claude', adapter: ClaudeAdapter },
  { name: 'antigravity', adapter: AntigravityAdapter },
];

for (const { name, adapter } of ADAPTER_CASES) {
  test(`CANCEL-${name}: 运行中的 ${name} run 被精确取消并报告 cancelled 证据`, async () => {
    const work = tmpDir(`af-cancel-${name}-`);
    const runId = `RUN-CANCEL-${name.toUpperCase()}-${Date.now()}`;

    try {
      const runPromise = adapter.run({
        runId,
        task_id: `TASK-CANCEL-${name.toUpperCase()}`,
        assigned_role: 'author',
        prompt: 'hang until cancelled',
        cwd: work,
        timeout_ms: 20000,
      });

      await waitForRunHandle(runId);
      const evidence = await adapter.cancel(runId);
      const result = await runPromise;

      assert.strictEqual(evidence.cancelled, true, `${name}: cancel must mark the run cancelled`);
      assert.strictEqual(evidence.run_id, runId);
      assert.strictEqual(evidence.already_exited, false, `${name}: the run must have been live`);
      assert.ok(typeof evidence.pid === 'number' && evidence.pid > 0, `${name}: real pid expected`);

      assert.strictEqual(result.status, 'cancelled', `${name}: run must resolve as cancelled`);
      assert.match(String(result.error), /cancelled by operator/i);
      assert.strictEqual(
        result.error_classification?.retryable,
        false,
        `${name}: a cancelled run must never be retried`
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

test('CANCEL-race: 进程注册前到达的取消请求，仍会终止随后启动的进程', async () => {
  const { cancelRun } = await import('../lib/adapters.mjs');
  const work = tmpDir('af-cancel-race-');
  const runId = `RUN-RACE-${Date.now()}`;

  try {
    // The scheduler announces the run id a moment before the process exists, so
    // a cancel can land when there is no handle to terminate yet.
    const early = await cancelRun(runId, { graceMs: 500 });
    assert.strictEqual(early.already_exited, true, 'no handle exists yet - nothing to terminate');

    // The request is recorded, so when the run actually starts it must be
    // honoured rather than letting the process run to completion behind a task
    // that is already CANCELLED.
    const result = await ClaudeAdapter.run({
      runId,
      task_id: 'TASK-CANCEL-RACE',
      assigned_role: 'author',
      prompt: 'hang until cancelled',
      cwd: work,
      timeout_ms: 15000,
    });

    assert.strictEqual(result.status, 'cancelled', 'the late-registered process must still be cancelled');
    assert.match(String(result.error), /cancelled by operator/i);
    assert.strictEqual(result.error_classification?.retryable, false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('CANCEL-scheduler: 取消运行中的任务写入 CANCELLED 且不被回卷的 run 覆盖', { timeout: 30000 }, async () => {
  const work = tmpDir('af-cancel-sched-');
  const taskId = 'TASK-CANCEL-SCHED';
  let sched = null;
  try {
    sched = new Scheduler({ tasksDir: work, adapters: { codex: CodexAdapter } });
    sched.enqueue({
      task_id: taskId,
      goal: 'cancel a running task',
      acceptance: 'exit 0',
      fixture_dir: work,
      author_executor: 'codex',
      reviewer_executor: 'codex',
    });

    sched.runNext();

    // AUTHOR_RUNNING is persisted, and the active run id is announced, before
    // the process is registered - so wait for the durable run handle, which is
    // written once the run is actually live and cancellable.
    const deadline = Date.now() + 8000;
    let activeRunId = null;
    while (Date.now() < deadline) {
      activeRunId = sched.active.get(taskId)?.activeRunId ?? null;
      if (activeRunId && existsSync(join(RUNS_DIR, `${activeRunId}.json`))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(activeRunId, 'the scheduler must register the active run id');
    assert.ok(
      existsSync(join(RUNS_DIR, `${activeRunId}.json`)),
      'the run handle must be durable before cancellation'
    );

    const running = JSON.parse(readFileSync(join(work, `${taskId}.json`), 'utf8'));
    assert.strictEqual(running.state, 'AUTHOR_RUNNING', 'the task must be mid-run before cancelling');

    sched.cancelTask(taskId);
    await sched.waitAll();

    const settled = JSON.parse(readFileSync(join(work, `${taskId}.json`), 'utf8'));
    assert.strictEqual(settled.state, 'CANCELLED', 'the unwinding run must not overwrite CANCELLED');
    assert.strictEqual(settled.runs.length, 1, 'a cancelled task must not be re-run');
    assert.strictEqual(settled.retryable, false);
  } finally {
    // best effort: never leave a hanging child behind if an assertion failed
    try { sched?.cancelTask(taskId); } catch { /* already settled */ }
    rmSync(work, { recursive: true, force: true });
  }
});
