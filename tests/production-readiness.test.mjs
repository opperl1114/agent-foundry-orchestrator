// tests/production-readiness.test.mjs - PHASE 8-A: Production Readiness Failure Injection Tests
//
// TEST PROD-1: executor crash -> task recover
// TEST PROD-2: executor 403 -> no retry, no fallback (fail closed)
// TEST PROD-3: scheduler SIGTERM -> no orphan process
// TEST PROD-4: runtime state corruption -> fail closed
// TEST PROD-5: two orchestrator instances -> lock isolation

import { test } from 'node:test';
import './helpers/tasks-dir-fixture.mjs';
import './helpers/executors-fixture.mjs';
import assert from 'node:assert';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import './helpers/acceptance-allowlist.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import './helpers/runtime-state-fixture.mjs';
import { RUNS_DIR } from '../lib/config.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { classifyExecutionError } from '../lib/executor-error-classifier.mjs';
import { acceptanceBinding } from '../lib/acceptance.mjs';
import { saveTaskAtomic, readTaskFile } from '../lib/store.mjs';
import { recoverTask, scanRecovery } from '../lib/recovery.mjs';
import { acquireTaskLock, releaseTaskLock, readLock, LockHeldError } from '../lib/tasklock.mjs';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';
import {
  getAllActiveRuns,
  terminateAllActiveRuns,
  registerActiveRun,
} from '../lib/adapters.mjs';
import { continueTask } from '../orchestrator.mjs';

let seq = 0;
const PASS = { decision: 'PASS', summary: 'ok', issues: [], required_changes: [], evidence: ['e'] };

function makeFake(type, script = []) {
  const counters = {};
  const calls = [];
  const next = (capsule) => {
    const role = capsule.assigned_role;
    const arr = Array.isArray(script) ? script : (script[role] ?? []);
    const i = counters[role] ?? 0;
    counters[role] = i + 1;
    const item = arr[Math.min(i, arr.length - 1)];
    return typeof item === 'function' ? item(i + 1, capsule) : item;
  };
  const wrap = (res) => {
    if (res?.review) return { result: '```json\n' + JSON.stringify(res.review) + '\n```' };
    return { result: res?.text ?? '' };
  };
  return {
    type,
    supportsMcpUnattended: true,
    calls,
    async run(capsule) {
      const res = next(capsule);
      calls.push({ kind: 'run', role: capsule.assigned_role });
      const runId = capsule.runId ?? `RUN-${++seq}`;
      if (res?.status === 'failed') {
        return {
          executor_run_id: runId,
          executor_type: type,
          assigned_role: capsule.assigned_role,
          status: 'failed',
          session_ref: null,
          structured_result: null,
          exit_code: res.exit_code ?? 1,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: res.error || 'simulated executor crash',
          error_classification: res.error_classification || null,
        };
      }
      return {
        executor_run_id: runId,
        executor_type: type,
        assigned_role: capsule.assigned_role,
        status: 'completed',
        session_ref: res?.sessionRef || `SESS-${runId}`,
        structured_result: wrap(res),
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
      };
    },
    async resume(sessionRef, capsule) {
      const res = next(capsule);
      calls.push({ kind: 'resume', sessionRef, role: capsule.assigned_role });
      const runId = capsule.runId ?? `RUN-${++seq}`;
      return {
        executor_run_id: runId,
        executor_type: type,
        assigned_role: capsule.assigned_role,
        status: 'completed',
        session_ref: sessionRef,
        structured_result: wrap(res),
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
      };
    },
    cancel(runId) {
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
    goal: 'Production failure injection verification',
    acceptance: 'test exits cleanly',
    fixture_dir: fixtureDir,
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: [],
    review_rules: ['audit safety'],
    requires_mcp: false,
    author_executor: 'claude',
    reviewer_executor: 'claude',
    max_revisions: 3,
  };
}

test('TEST PROD-1: executor crash -> task recover', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'af-prod1-work-'));
  try {
    const taskId = `TASK-PROD1-${Date.now()}`;
    // 模拟场景：作者执行完毕产物已持久化，但审查器崩溃/进程死亡，导致任务停留在 AUTHOR_RUNNING
    const taskDef = {
      ...wsTask(taskId, workDir),
      state: 'AUTHOR_RUNNING',
      last_author_content: '# Durable author work ready for review\n',
      author_content_revision: 1,
      author_session_ref: 'SESS-AUTHOR-CRASH-SAFE',
      author_session_executor_type: 'claude',
      runs: [{
        executor_run_id: 'RUN-AUTHOR-1',
        executor_type: 'claude',
        assigned_role: 'author',
        purpose: 'author',
        status: 'completed',
        session_ref: 'SESS-AUTHOR-CRASH-SAFE',
      }],
    };
    // Crash-state fixtures carry the acceptance trust anchor, as a real task at
    // that point would (see H2: an absent anchor is now refused).
    taskDef.acceptance_binding = taskDef.acceptance_binding ?? acceptanceBinding(taskDef);
    saveTaskAtomic(join(workDir, `${taskId}.json`), taskDef);

    // 独立审查器 fake
    const reviewerFake = makeFake('claude', [{ sessionRef: 'REV-RECOVERED', review: PASS }]);
    const adapters = { claude: reviewerFake };

    // 执行恢复
    const recoveryResult = await recoverTask(taskId, {
      tasksDir: workDir,
      locksDir: workDir,
      continueTaskFn: (id, o = {}) => continueTask(id, adapters, { ...o, tasksDir: workDir }),
      resumeGovernanceFn: () => {},
      adapters,
      orchestratorInstanceId: 'af-orch-prod1-recovery',
    });

    assert.strictEqual(recoveryResult.outcome, 'RECOVERED');
    assert.strictEqual(recoveryResult.task.state, 'COMPLETED', 'Crashed task must recover cleanly to COMPLETED');

    // 证明作者未被重新运行（会话标识不变，只有1次作者运行，新增1次审查运行）
    const authorRuns = recoveryResult.task.runs.filter((r) => r.purpose === 'author');
    assert.strictEqual(authorRuns.length, 1, 'Author run must NOT be re-executed');
    assert.strictEqual(authorRuns[0].session_ref, 'SESS-AUTHOR-CRASH-SAFE');
    const reviewRuns = recoveryResult.task.runs.filter((r) => r.purpose === 'review');
    assert.strictEqual(reviewRuns.length, 1, 'Reviewer must run independently to complete review');

    // 场景 2：作者中途崩溃无产物 -> recovery 识别为 INTERRUPTED / UNKNOWN_OUTCOME，绝不伪造 PASS 或 FAILED
    const crashMidflightId = `TASK-PROD1-MIDFLIGHT-${Date.now()}`;
    const midflightDef = {
      ...wsTask(crashMidflightId, workDir),
      state: 'AUTHOR_RUNNING',
      last_author_content: null,
      runs: [],
    };
    midflightDef.acceptance_binding = midflightDef.acceptance_binding ?? acceptanceBinding(midflightDef);
    saveTaskAtomic(join(workDir, `${crashMidflightId}.json`), midflightDef);

    const midflightRecovery = await recoverTask(crashMidflightId, {
      tasksDir: workDir,
      locksDir: workDir,
      continueTaskFn: () => {},
      resumeGovernanceFn: () => {},
      adapters,
      orchestratorInstanceId: 'af-orch-prod1-recovery',
    });

    assert.strictEqual(midflightRecovery.classification, 'INTERRUPTED');
    assert.strictEqual(midflightRecovery.state, 'AUTHOR_RUNNING');
    const persistedMidflight = readTaskFile(join(workDir, `${crashMidflightId}.json`));
    const intrRun = persistedMidflight.runs.find((r) => r.execution_outcome === 'interrupted');
    assert.ok(intrRun, 'Interrupted run placeholder must be explicitly recorded');
    assert.notStrictEqual(persistedMidflight.state, 'COMPLETED');
    assert.notStrictEqual(persistedMidflight.state, 'FAILED');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('TEST PROD-2: executor 403 -> no retry, no fallback (fail closed)', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'af-prod2-work-'));
  try {
    let vgRunCalls = 0;
    let claudeRunCalls = 0;

    const vgFake = {
      type: 'vertex-gemini',
      supportsMcpUnattended: true,
      async run(capsule) {
        vgRunCalls += 1;
        // N11: report the RAW evidence and let the real classifier decide. This
        // test used to inject a pre-baked error_classification, which is why the
        // classifier's stdout blind spot (C1) could sit here undetected: the
        // assertion was checking the test's own literal, not the product code.
        // The refusal is on stdout with an empty stderr, exactly the shape codex
        // produces with --json.
        const stdout = '{"type":"error","message":"unexpected status 403 Forbidden: account suspended for Terms of Service violation"}';
        return {
          executor_run_id: 'RUN-VG-403',
          executor_type: 'vertex-gemini',
          assigned_role: capsule.assigned_role,
          status: 'failed',
          session_ref: null,
          structured_result: null,
          exit_code: 1,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: '403 PERMISSION_DENIED: Service disabled for TOS_VIOLATION',
          error_classification: classifyExecutionError('vertex-gemini', {
            exit_code: 1,
            stdout,
            stderr: '',
          }),
        };
      },
      cancel() { return { cancelled: true }; },
    };

    const claudeFake = {
      type: 'claude',
      supportsMcpUnattended: true,
      async run(capsule) {
        claudeRunCalls += 1;
        return {
          executor_run_id: 'RUN-CLAUDE-FALLBACK',
          executor_type: 'claude',
          assigned_role: capsule.assigned_role,
          status: 'completed',
          session_ref: 'SESS-CLAUDE',
          structured_result: { result: 'should not be called' },
          exit_code: 0,
        };
      },
      cancel() { return { cancelled: true }; },
    };

    const scheduler = new Scheduler({
      maxConcurrent: 2,
      maxExecutorRetries: 3, // 即使配置了 3 次重试
      tasksDir: workDir,
      adapters: { 'vertex-gemini': vgFake, claude: claudeFake },
    });

    const taskId = 'TASK-PROD2-403-FAILCLOSED';
    const taskDef = {
      ...wsTask(taskId, workDir),
      author_executor: 'vertex-gemini',
      allow_fallback: true,
      fallbacks: ['claude'], // 即使明确配置了 fallback
    };
    saveTaskAtomic(join(workDir, `${taskId}.json`), taskDef);

    scheduler.enqueue(taskDef);
    scheduler.runNext();

    // 等待调度执行完成
    await scheduler.waitAll();

    const finalTask = readTaskFile(join(workDir, `${taskId}.json`));
    assert.strictEqual(finalTask.state, 'FAILED', 'Task must fail closed immediately');
    assert.strictEqual(finalTask.error_classification?.category, 'ACCOUNT_POLICY');
    // The safety action comes from the real classifier (the old test asserted a
    // literal 'OPEN_CIRCUIT_MANUAL_RESET' that no code path produces).
    assert.strictEqual(finalTask.error_classification?.safety_action, 'OPEN_MANUAL_RESET');
    assert.strictEqual(finalTask.error_classification?.retryable, false);
    assert.strictEqual(vgRunCalls, 1, 'Must NOT retry on 403 ACCOUNT_POLICY (retries = 0)');
    assert.strictEqual(claudeRunCalls, 0, 'Must NEVER fallback on 403 ACCOUNT_POLICY (fallbacks called = 0)');

    // 验证事件记录 fallback_forbidden
    const fallbackForbiddenEvent = scheduler.events.find((e) => e.kind === 'fallback_forbidden');
    assert.ok(fallbackForbiddenEvent, 'fallback_forbidden audit event must be emitted');
    assert.strictEqual(fallbackForbiddenEvent.category, 'ACCOUNT_POLICY');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('TEST PROD-3: scheduler SIGTERM -> no orphan process', async () => {
  const runsDir = RUNS_DIR;
  mkdirSync(runsDir, { recursive: true });

  const runId = `RUN-PROD3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const taskId = 'TASK-PROD3-ORPHAN-CHECK';

  // 启动真实长时间运行的子进程
  const child = spawn('node', ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  assert.ok(pid && pid > 0, 'Child process must be running with valid PID');

  // 确认初始进程存活
  let isAlive = true;
  try {
    process.kill(pid, 0);
  } catch {
    isAlive = false;
  }
  assert.ok(isAlive, 'Child process must be alive initially');

  // 注册运行句柄
  registerActiveRun(runId, { child, task_id: taskId, adapter_type: 'test-child' });
  const handleFile = join(runsDir, `${runId}.json`);
  writeFileSync(handleFile, JSON.stringify({
    run_id: runId,
    task_id: taskId,
    pid,
    adapter_type: 'test-child',
    started_at: new Date().toISOString(),
  }, null, 2));

  // 执行所有活动运行的终止回收
  const terminationResults = await terminateAllActiveRuns({ graceMs: 2000 });
  const result = terminationResults.find((r) => r.run_id === runId);
  assert.ok(result, 'Termination result must be returned');
  assert.strictEqual(result.termination_signal, 'SIGTERM');

  // 等待并验证操作系统层面子进程彻底消失（ESRCH）
  let stillAlive = true;
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      stillAlive = false;
      break;
    }
  }
  assert.strictEqual(stillAlive, false, 'Child process must be terminated (zero orphan process)');

  // 验证句柄文件被销毁
  assert.strictEqual(existsSync(handleFile), false, 'Handle file must be cleaned up (no orphan handle)');

  // 验证活跃注册表为空
  const activeAfter = getAllActiveRuns();
  assert.ok(!activeAfter.some((r) => r.run_id === runId), 'Active run registry must be released');
});

test('TEST PROD-4: runtime state corruption -> fail closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-prod4-corrupt-'));
  try {
    // 1. 任务文件 JSON 损坏 (half-written JSON)
    const corruptTaskId = 'TASK-PROD4-CORRUPT';
    const corruptFilePath = join(dir, `${corruptTaskId}.json`);
    writeFileSync(corruptFilePath, '{"task_id": "TASK-PROD4-CORRUPT", "state": "AUTHOR_RUNNING", "goal": "inval', 'utf8');

    // 验证 Recovery Scanner 面对损坏文件：不崩溃，归类为 UNSAFE_TO_AUTO_RESUME，严禁自动拉起
    const rows = scanRecovery(dir, { availability: { claude: { availability_status: 'AVAILABLE' } } });
    const corruptRow = rows.find((r) => r.file === `${corruptTaskId}.json`);
    assert.ok(corruptRow, 'Corrupted task file must be indexed');
    assert.strictEqual(corruptRow.recovery_class, 'UNSAFE_TO_AUTO_RESUME');
    assert.strictEqual(corruptRow.reason, 'unreadable task file');

    // 2. 原子写入故障注入：验证写入过程中崩溃时，目标文件不受半写入损坏
    const validTaskId = 'TASK-PROD4-VALID';
    const validFilePath = join(dir, `${validTaskId}.json`);
    saveTaskAtomic(validFilePath, { task_id: validTaskId, state: 'CREATED', version: 1 });

    assert.throws(
      () => {
        saveTaskAtomic(validFilePath, { task_id: validTaskId, state: 'MODIFIED', version: 2 }, { fail: 'write' });
      },
      /injected write failure/
    );

    // 检查原文件内容保持不变，未被污染
    const preservedContent = readTaskFile(validFilePath);
    assert.strictEqual(preservedContent.state, 'CREATED', 'Target file must remain intact when write fails');
    assert.strictEqual(preservedContent.version, 1);

    // 3. 锁文件内容损坏 (corrupted lock file)
    const locksDir = join(dir, 'locks');
    mkdirSync(locksDir, { recursive: true });
    const corruptLockPath = join(locksDir, `${validTaskId}.lock`);
    writeFileSync(corruptLockPath, '{corrupted-json-syntax-no-valid-pid', 'utf8');

    // readLock 返回 null
    assert.strictEqual(readLock(locksDir, validTaskId), null);

    // acquireTaskLock 能安全检测到损坏锁，记录 corrupt_lock_file 并回收接管，防止永久死锁
    const lockAcquired = acquireTaskLock(locksDir, validTaskId, {
      orchestratorInstanceId: 'af-orch-prod4-fixer',
    });
    assert.strictEqual(lockAcquired.stale_lock_recovered, true);
    assert.strictEqual(lockAcquired.recovered_from.stale_reason, 'corrupt_lock_file');
    releaseTaskLock(locksDir, validTaskId, lockAcquired.lock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TEST PROD-5: two orchestrator instances -> lock isolation', async () => {
  const locksDir = mkdtempSync(join(tmpdir(), 'af-prod5-locks-'));
  try {
    const taskId = 'TASK-PROD5-ISOLATION';

    // 实例 1 (Instance A) 成功获取锁
    const instanceA = 'af-orch-instance-A';
    const lockInfoA = acquireTaskLock(locksDir, taskId, {
      orchestratorInstanceId: instanceA,
      pid: process.pid,
      leaseMs: 60000,
    });
    assert.ok(lockInfoA.lock, 'Instance A must acquire lock');
    assert.strictEqual(lockInfoA.lock.orchestrator_instance_id, instanceA);

    // 实例 2 (Instance B) 尝试获取同一任务锁，必须被强行拒绝 (TASK_ALREADY_RUNNING)
    const instanceB = 'af-orch-instance-B';
    assert.throws(
      () => {
        acquireTaskLock(locksDir, taskId, {
          orchestratorInstanceId: instanceB,
          pid: process.pid + 1, // 模拟另一进程
          leaseMs: 60000,
        });
      },
      (err) => {
        assert.ok(err instanceof LockHeldError);
        assert.strictEqual(err.code, 'TASK_ALREADY_RUNNING');
        assert.strictEqual(err.lock.orchestrator_instance_id, instanceA);
        return true;
      },
      'Instance B must be rejected while Instance A holds a valid lock'
    );

    // 验证锁未被 Instance B 篡改
    const currentLock = readLock(locksDir, taskId);
    assert.strictEqual(currentLock.orchestrator_instance_id, instanceA);

    // 实例 1 释放锁
    releaseTaskLock(locksDir, taskId, lockInfoA.lock);

    // 锁释放后，实例 2 可以顺利获取
    const lockInfoB = acquireTaskLock(locksDir, taskId, {
      orchestratorInstanceId: instanceB,
      pid: process.pid + 1,
      leaseMs: 60000,
    });
    assert.ok(lockInfoB.lock);
    assert.strictEqual(lockInfoB.lock.orchestrator_instance_id, instanceB);
    releaseTaskLock(locksDir, taskId, lockInfoB.lock);
  } finally {
    rmSync(locksDir, { recursive: true, force: true });
  }
});
