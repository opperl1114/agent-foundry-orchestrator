// tests/shutdown.test.mjs - PHASE 7-A: Graceful Shutdown Hardening test suite
// TEST SH-1: 运行中收到 SIGTERM -> active run 被 cancel -> 任务状态正确记录
// TEST SH-2: shutdown 过程中提交新任务 -> 被拒绝 (SYSTEM_SHUTTING_DOWN)
// TEST SH-3: 被中断任务重启后 -> recovery scan 正确识别（非静默 FAILED）
// TEST SH-4: 进程清理验证 -> 无 orphan handle / active run 释放

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Scheduler } from '../lib/scheduler.mjs';
import { saveTaskAtomic } from '../lib/store.mjs';
import { scanRecovery } from '../lib/recovery.mjs';
import {
  getAllActiveRuns,
  terminateAllActiveRuns,
  registerActiveRun,
} from '../lib/adapters.mjs';
import { installGracefulShutdown } from '../orchestrator.mjs';

let seq = 0;
function makeHangingFake(type) {
  const resolvers = new Map();
  let cancelCalled = 0;
  const cancelledRunIds = [];
  return {
    type,
    supportsMcpUnattended: true,
    get cancelCalled() { return cancelCalled; },
    get cancelledRunIds() { return [...cancelledRunIds]; },
    get pendingRunIds() { return [...resolvers.keys()]; },
    resolveRun(runId, status = 'completed') {
      resolvers.get(runId)?.({ status });
      resolvers.delete(runId);
    },
    async run(capsule) {
      const runId = capsule.runId ?? `RUN-${++seq}`;
      const result = await new Promise((res) => { resolvers.set(runId, res); });
      resolvers.delete(runId);
      const structured_result = capsule.response_schema
        ? { result: JSON.stringify({ decision: 'PASS', summary: 'ok', issues: [], required_changes: [], evidence: ['e'] }) }
        : { result: '' };
      return {
        executor_run_id: runId,
        executor_type: type,
        assigned_role: capsule.assigned_role,
        status: result.status,
        session_ref: `SESS-${runId}`,
        structured_result,
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
      };
    },
    async resume(sessionRef, capsule) {
      const runId = capsule.runId ?? `RUN-${++seq}`;
      const result = await new Promise((res) => { resolvers.set(runId, res); });
      resolvers.delete(runId);
      return {
        executor_run_id: runId,
        executor_type: type,
        assigned_role: capsule.assigned_role,
        status: result.status,
        session_ref: sessionRef,
        structured_result: { result: '' },
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
      };
    },
    cancel(runId) {
      cancelCalled += 1;
      cancelledRunIds.push(runId);
      resolvers.get(runId)?.({ status: 'cancelled' });
      resolvers.delete(runId);
      return {
        run_id: runId,
        already_exited: false,
        termination_signal: 'SIGTERM',
        forced: false,
        process_exit_observed: true,
      };
    },
  };
}

function wsTask(id, fixtureDir) {
  return {
    task_id: id,
    task_mode: 'workspace',
    goal: 'Graceful shutdown hardening validation',
    acceptance: 'test exits cleanly',
    fixture_dir: fixtureDir,
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: [],
    review_rules: ['verify shutdown integrity'],
    requires_mcp: false,
    author_executor: 'claude',
    reviewer_executor: 'claude',
    max_revisions: 3,
  };
}

test('TEST SH-1: 运行中收到 SIGTERM -> active run 被 cancel -> 任务状态正确记录', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'af-sh1-work-'));
  try {
    const fake = makeHangingFake('claude');
    const scheduler = new Scheduler({
      maxConcurrent: 2,
      tasksDir: workDir,
      adapters: {
        claude: fake,
        antigravity: makeHangingFake('antigravity'),
        codex: makeHangingFake('codex'),
      },
    });

    let signalCaught = null;
    let signalDone;
    const signalFinished = new Promise((res) => { signalDone = res; });
    const { uninstall } = installGracefulShutdown(scheduler, {
      exitOnComplete: false,
      signalHandler: (sig) => {
        signalCaught = sig;
        signalDone();
      },
    });

    const taskId = `TASK-SH1-${Date.now()}`;
    const taskDef = wsTask(taskId, workDir);
    saveTaskAtomic(join(workDir, `${taskId}.json`), taskDef);
    scheduler.enqueue({ ...taskDef });
    scheduler.runNext();

    // Wait until task is actively executing in scheduler
    for (let i = 0; i < 50 && !scheduler.active.has(taskId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(scheduler.active.has(taskId), 'task must be active before SIGTERM');

    // Trigger graceful shutdown via SIGTERM
    process.emit('SIGTERM', 'SIGTERM');

    // Wait for the signal handler and shutdown to complete
    await signalFinished;
    uninstall();

    assert.strictEqual(signalCaught, 'SIGTERM', 'signalHandler must catch SIGTERM');
    assert.strictEqual(scheduler.shutdownRequested, true, 'shutdownRequested must be marked true');
    assert.strictEqual(fake.cancelCalled, 1, 'active run must receive cancel precisely once');

    // Verify task state and termination evidence
    const saved = JSON.parse(readFileSync(join(workDir, `${taskId}.json`), 'utf8'));
    assert.strictEqual(saved.state, 'CANCELLED', 'Task state must be CANCELLED');
    assert.ok(saved.cancelled_at, 'cancelled_at timestamp must be recorded');
    assert.ok(saved.termination, 'termination evidence must be populated');
    assert.strictEqual(saved.termination.signal, 'SIGTERM');
    assert.strictEqual(scheduler.active.size, 0, 'active tasks count must be 0 after shutdown');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('TEST SH-2: shutdown 过程中提交新任务 -> 被拒绝 (SYSTEM_SHUTTING_DOWN)', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'af-sh2-work-'));
  try {
    const scheduler = new Scheduler({
      maxConcurrent: 2,
      tasksDir: workDir,
    });

    // Enter shutdown state
    await scheduler.shutdown({ signal: 'SIGTERM', mode: 'cancel' });
    assert.strictEqual(scheduler.status().shutdown_requested, true);

    const taskId = 'TASK-SH2-REJECT';
    const taskDef = wsTask(taskId, workDir);
    saveTaskAtomic(join(workDir, `${taskId}.json`), taskDef);

    // 1. enqueue() must throw SYSTEM_SHUTTING_DOWN
    assert.throws(
      () => scheduler.enqueue(taskDef),
      (err) => err.code === 'SYSTEM_SHUTTING_DOWN',
      'enqueue must be refused with SYSTEM_SHUTTING_DOWN'
    );

    // 2. runTask() must throw SYSTEM_SHUTTING_DOWN
    assert.throws(
      () => scheduler.runTask(taskId),
      (err) => err.code === 'SYSTEM_SHUTTING_DOWN',
      'runTask must be refused with SYSTEM_SHUTTING_DOWN'
    );

    // 3. resumeTask() must throw SYSTEM_SHUTTING_DOWN
    assert.throws(
      () => scheduler.resumeTask(taskId),
      (err) => err.code === 'SYSTEM_SHUTTING_DOWN',
      'resumeTask must be refused with SYSTEM_SHUTTING_DOWN'
    );

    // 4. runNext() must return status without dispatching work
    const st = scheduler.runNext();
    assert.strictEqual(st.shutdown_requested, true);
    assert.strictEqual(st.active.length, 0);
    assert.strictEqual(st.queued.length, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('TEST SH-3: 被中断任务重启后 -> recovery scan 正确识别（非静默 FAILED）', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'af-sh3-work-'));
  try {
    const fake = makeHangingFake('claude');
    const scheduler = new Scheduler({
      maxConcurrent: 2,
      tasksDir: workDir,
      adapters: {
        claude: fake,
        antigravity: makeHangingFake('antigravity'),
        codex: makeHangingFake('codex'),
      },
    });

    const taskIntrId = 'TASK-SH3-INTR';
    const taskDef = wsTask(taskIntrId, workDir);
    saveTaskAtomic(join(workDir, `${taskIntrId}.json`), taskDef);
    scheduler.enqueue({ ...taskDef });
    scheduler.runNext();

    for (let i = 0; i < 50 && !scheduler.active.has(taskIntrId); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(scheduler.active.has(taskIntrId));

    // Shutdown with mode: 'interrupt' (simulates host shutdown / power-off / restart)
    await scheduler.shutdown({ mode: 'interrupt', signal: 'SIGTERM' });

    // Verify task state on disk was NOT silently overwritten with FAILED
    const persisted = JSON.parse(readFileSync(join(workDir, `${taskIntrId}.json`), 'utf8'));
    assert.notStrictEqual(persisted.state, 'FAILED', 'Interrupted task MUST NOT be silently marked FAILED');
    assert.strictEqual(persisted.state, 'AUTHOR_RUNNING');
    assert.ok(persisted.interrupted_at, 'interrupted_at must be recorded');

    // Simulate restart: recovery scan discovers the interrupted task
    const rows = scanRecovery(workDir, {
      availability: { claude: { availability_status: 'AVAILABLE' } },
    });
    const targetIntr = rows.find((r) => r.task_id === taskIntrId);
    assert.ok(targetIntr, 'Interrupted task must be found in recovery scan');
    assert.strictEqual(targetIntr.recovery_class, 'INTERRUPTED', 'Must be classified as INTERRUPTED (UNKNOWN_OUTCOME)');
    assert.strictEqual(targetIntr.state, 'AUTHOR_RUNNING');
    assert.notStrictEqual(targetIntr.recovery_class, 'TERMINAL');

    // Verify a task that had completed author and was interrupted during review is RESUMABLE
    const taskRevId = 'TASK-SH3-REV';
    const taskRevDef = {
      ...wsTask(taskRevId, workDir),
      state: 'REVIEW_RUNNING',
      last_author_content: '# Generated durable content\n',
      runs: [{
        executor_run_id: 'RUN-AUTHOR-DONE',
        executor_type: 'claude',
        assigned_role: 'author',
        purpose: 'author',
        status: 'completed',
        session_ref: 'SESS-A',
      }],
      author_session_ref: 'SESS-A',
      author_session_executor_type: 'claude',
    };
    saveTaskAtomic(join(workDir, `${taskRevId}.json`), taskRevDef);

    const rows2 = scanRecovery(workDir, {
      availability: { claude: { availability_status: 'AVAILABLE' } },
    });
    const targetRev = rows2.find((r) => r.task_id === taskRevId);
    assert.ok(targetRev);
    assert.strictEqual(targetRev.recovery_class, 'RESUMABLE', 'Interrupted review with durable author must be RESUMABLE');

    // Verify a task in WAITING_HUMAN survives restart as WAITING_EXTERNAL
    const taskHumanId = 'TASK-SH3-HUMAN';
    const taskHumanDef = {
      ...wsTask(taskHumanId, workDir),
      task_mode: 'governed_write',
      state: 'WAITING_HUMAN',
      governance: { candidate_id: 'CAND-SH3-123' },
    };
    saveTaskAtomic(join(workDir, `${taskHumanId}.json`), taskHumanDef);

    const rows3 = scanRecovery(workDir, {
      availability: { claude: { availability_status: 'AVAILABLE' } },
    });
    const targetHuman = rows3.find((r) => r.task_id === taskHumanId);
    assert.ok(targetHuman);
    assert.strictEqual(targetHuman.recovery_class, 'WAITING_EXTERNAL', 'WAITING_HUMAN must survive as WAITING_EXTERNAL');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('TEST SH-4: 进程清理验证 -> 无 orphan handle / active run 释放', async () => {
  const runsDir = join(process.cwd(), 'runtime', 'runs');
  mkdirSync(runsDir, { recursive: true });

  const runId = `RUN-SH4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const taskId = 'TASK-SH4-ORPHAN-CHECK';

  // Spawn a real long-running child process
  const child = spawn('node', ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  assert.ok(pid && pid > 0, 'Child process must be spawned with valid PID');

  // Verify child process is running
  let isAlive = true;
  try {
    process.kill(pid, 0);
  } catch {
    isAlive = false;
  }
  assert.ok(isAlive, 'Child process must be alive initially');

  // Register in active run registry and create durable handle file
  registerActiveRun(runId, { child, task_id: taskId, adapter_type: 'test-child' });
  const handleFile = join(runsDir, `${runId}.json`);
  writeFileSync(handleFile, JSON.stringify({
    run_id: runId,
    task_id: taskId,
    pid,
    adapter_type: 'test-child',
    started_at: new Date().toISOString(),
  }, null, 2));

  // Verify active run is visible in registry and disk
  assert.ok(existsSync(handleFile), 'Handle file must exist in runtime/runs/');
  const activeBefore = getAllActiveRuns();
  assert.ok(activeBefore.some((r) => r.run_id === runId), 'Run must be registered in getAllActiveRuns()');

  // Execute graceful termination of all active runs
  const terminationResults = await terminateAllActiveRuns({ graceMs: 2000 });
  const result = terminationResults.find((r) => r.run_id === runId);
  assert.ok(result, 'Termination result must be returned for runId');
  assert.strictEqual(result.termination_signal, 'SIGTERM');

  // Verify child process was terminated
  let stillAlive = true;
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      stillAlive = false;
      break;
    }
  }
  assert.strictEqual(stillAlive, false, 'Child process must not be alive (no orphan process)');

  // Verify handle file was unlinked
  assert.strictEqual(existsSync(handleFile), false, 'Handle file must be cleaned up (no orphan handle)');

  // Verify active runs registry is released
  const activeAfter = getAllActiveRuns();
  assert.ok(!activeAfter.some((r) => r.run_id === runId), 'Active run registry must be released');
});
