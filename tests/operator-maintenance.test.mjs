// tests/operator-maintenance.test.mjs - PHASE 7-B: Operator Maintenance Layer tests
//
// Tests:
//   TEST OPS-M1: executor status 输出三层状态 (Capability, Availability, Runtime Safety)
//   TEST OPS-M2: circuit reset 必须需要reason
//   TEST OPS-M3: reset产生audit event
//   TEST OPS-M4: tasks prune dry-run 不会删除非终态任务
//   TEST OPS-M5: logs rotate 不改变事件内容
//   TEST OPS-M6: 冷却状态投影 OPEN_COOLDOWN 到期显示 HALF_OPEN_PENDING (无自动transition)

import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';
import {
  getExecutorOperationsStatus,
  formatExecutorStatus,
  listCircuitBreakers,
  formatCircuitList,
  resetCircuitBreaker,
  readRuntimeAuditEvents,
  pruneTasks,
  formatTasksPruneResult,
  rotateLogs,
  formatLogRotationResult,
} from '../lib/executor-ops.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeExecDir(dir) {
  const execDir = join(dir, 'executors');
  mkdirSync(execDir, { recursive: true });
  writeFileSync(join(execDir, 'claude.json'), JSON.stringify({
    executor_id: 'claude',
    capabilities_audit: { m1: 'PASS', m2: 'PASS' },
    blockers: [],
  }));
  writeFileSync(join(execDir, 'antigravity.json'), JSON.stringify({
    executor_id: 'antigravity',
    capabilities_audit: { m1: 'PASS', m2: 'PASS' },
    blockers: ['403 Terms of Service violation (account disabled)'],
  }));
  writeFileSync(join(execDir, 'codex.json'), JSON.stringify({
    executor_id: 'codex',
    capabilities_audit: { m1: 'PASS' },
    blockers: [],
  }));
  return execDir;
}

test('TEST OPS-M1: executor status 输出三层状态', async () => {
  const dir = tmpDir('af-ops-m1-');
  const execDir = makeExecDir(dir);
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
  }));
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      category: 'ACCOUNT_POLICY',
      reason: 'TOS_VIOLATION',
      opened_at: '2026-09-05T00:00:00.000Z',
    },
  }));

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile, eventsLogFile });
  const status = getExecutorOperationsStatus('antigravity', { executorsDir: execDir, runtimeGuard: guard });

  // 1. 三层状态明确存在
  assert.strictEqual(status.capability, 'READY', 'Layer 1: Capability truth');
  assert.strictEqual(status.availability, 'ACCOUNT_DISABLED_403', 'Layer 2: Availability truth');
  assert.strictEqual(status.runtime, 'OPEN_MANUAL_RESET', 'Layer 3: Runtime safety state');
  assert.strictEqual(status.reason, 'TOS_VIOLATION', 'Blocker / failure reason');

  // 2. 格式化输出包含三层状态及 reason
  const formatted = formatExecutorStatus(status);
  assert.match(formatted, /capability:\nREADY/);
  assert.match(formatted, /availability:\nACCOUNT_DISABLED_403/);
  assert.match(formatted, /runtime:\nOPEN_MANUAL_RESET/);
  assert.match(formatted, /reason:\nTOS_VIOLATION/);

  // 3. 严格禁止输出敏感凭证字段
  const FORBIDDEN = ['token', 'credential', 'password', 'secret', 'api_key', 'private_key'];
  for (const forbidden of FORBIDDEN) {
    assert.strictEqual(
      formatted.toLowerCase().includes(forbidden),
      false,
      `Formatted status must not contain sensitive field: ${forbidden}`
    );
  }

  rmSync(dir, { recursive: true, force: true });
});

test('TEST OPS-M2: circuit reset 必须需要reason', async () => {
  const dir = tmpDir('af-ops-m2-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
  }));
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      category: 'ACCOUNT_POLICY',
      reason: 'TOS_VIOLATION',
      opened_at: '2026-09-05T00:00:00.000Z',
    },
  }));

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile, eventsLogFile });

  // 1. 未提供 reason 时抛出异常
  assert.throws(
    () => resetCircuitBreaker('antigravity', { runtimeGuard: guard }),
    (err) => {
      assert.match(err.message, /--reason is required/);
      return true;
    },
    'resetCircuitBreaker without reason must fail'
  );

  // 2. 传入空字符串或空白字符时抛出异常
  assert.throws(
    () => resetCircuitBreaker('antigravity', { reason: '   ', runtimeGuard: guard }),
    (err) => {
      assert.match(err.message, /--reason is required/);
      return true;
    },
    'resetCircuitBreaker with empty reason must fail'
  );

  // 3. 验证状态机未被破坏（熔断器依然保持 OPEN_MANUAL_RESET）
  assert.strictEqual(guard.getCircuitState('antigravity').state, 'OPEN_MANUAL_RESET');
  assert.strictEqual(guard.canExecute('antigravity'), false);

  rmSync(dir, { recursive: true, force: true });
});

test('TEST OPS-M3: reset产生audit event', async () => {
  const dir = tmpDir('af-ops-m3-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
  }));
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      category: 'ACCOUNT_POLICY',
      reason: 'TOS_VIOLATION',
      opened_at: '2026-09-05T00:00:00.000Z',
    },
  }));

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile, eventsLogFile });

  const resetRes = resetCircuitBreaker('antigravity', {
    reason: 'account suspension appealed and verified restored by Google Cloud team',
    reset_by: 'lead-operator-bob',
    runtimeGuard: guard,
  });

  assert.strictEqual(resetRes.state, 'CLOSED');
  assert.strictEqual(guard.canExecute('antigravity'), true);

  // 1. 验证 audit log 产生 CIRCUIT_RESET 事件
  const events = readRuntimeAuditEvents({ eventsLogFile });
  const resetEvent = events.find((e) => e.event === 'CIRCUIT_RESET');
  assert.ok(resetEvent, 'CIRCUIT_RESET event must be recorded in log');
  assert.strictEqual(resetEvent.executor, 'antigravity');
  assert.strictEqual(resetEvent.reset_by, 'lead-operator-bob');
  assert.strictEqual(resetEvent.reason, 'account suspension appealed and verified restored by Google Cloud team');
  assert.ok(resetEvent.timestamp, 'timestamp must exist');

  // 2. 审计事件中杜绝凭证泄漏
  const FORBIDDEN = ['token', 'credential', 'password', 'secret'];
  for (const k of Object.keys(resetEvent)) {
    assert.strictEqual(FORBIDDEN.includes(k.toLowerCase()), false);
  }

  rmSync(dir, { recursive: true, force: true });
});

test('TEST OPS-M4: tasks prune dry-run 不会删除非终态任务', async () => {
  const tasksDir = tmpDir('af-ops-m4-tasks-');

  // 创建任务样本集合：3 个终态，3 个活跃/受保护状态
  const tasks = [
    { task_id: 'TASK-COMPLETED-1', state: 'COMPLETED' },
    { task_id: 'TASK-FAILED-1', state: 'FAILED' },
    { task_id: 'TASK-CANCELLED-1', state: 'CANCELLED' },
    { task_id: 'TASK-RUNNING-1', state: 'AUTHOR_RUNNING' },
    { task_id: 'TASK-REVIEW-1', state: 'REVIEW_RUNNING' },
    { task_id: 'TASK-HUMAN-1', state: 'WAITING_HUMAN' },
    { task_id: 'TASK-WAITING-EXT-1', state: 'WAITING_EXTERNAL' },
  ];

  for (const t of tasks) {
    writeFileSync(join(tasksDir, `${t.task_id}.json`), JSON.stringify(t, null, 2));
  }

  // 1. Dry-run mode
  const dryRes = pruneTasks({ tasksDir, confirm: false });
  assert.strictEqual(dryRes.dry_run, true);
  assert.deepStrictEqual(
    dryRes.candidate_ids.sort(),
    ['TASK-CANCELLED-1', 'TASK-COMPLETED-1', 'TASK-FAILED-1'].sort(),
    'Only terminal tasks (COMPLETED, FAILED, CANCELLED) are candidates for pruning'
  );
  assert.strictEqual(dryRes.removed_ids.length, 0, 'No tasks must be removed during dry-run');

  // 格式化输出验证
  const dryText = formatTasksPruneResult(dryRes);
  assert.match(dryText, /would remove:/);
  assert.match(dryText, /TASK-COMPLETED-1/);
  assert.match(dryText, /TASK-FAILED-1/);
  assert.match(dryText, /TASK-CANCELLED-1/);
  assert.ok(!dryText.includes('TASK-RUNNING-1'));
  assert.ok(!dryText.includes('TASK-HUMAN-1'));
  assert.ok(!dryText.includes('TASK-WAITING-EXT-1'));

  // 确认在 dry-run 后，所有 7 个文件完好无损
  for (const t of tasks) {
    assert.ok(existsSync(join(tasksDir, `${t.task_id}.json`)), `File for ${t.task_id} must still exist after dry-run`);
  }

  // 2. Confirmed prune mode
  const pruneRes = pruneTasks({ tasksDir, confirm: true });
  assert.strictEqual(pruneRes.dry_run, false);
  assert.deepStrictEqual(
    pruneRes.removed_ids.sort(),
    ['TASK-CANCELLED-1', 'TASK-COMPLETED-1', 'TASK-FAILED-1'].sort()
  );

  // 验证终态文件已删除
  assert.strictEqual(existsSync(join(tasksDir, 'TASK-COMPLETED-1.json')), false);
  assert.strictEqual(existsSync(join(tasksDir, 'TASK-FAILED-1.json')), false);
  assert.strictEqual(existsSync(join(tasksDir, 'TASK-CANCELLED-1.json')), false);

  // 验证非终态任务（RUNNING、WAITING_HUMAN、WAITING_EXTERNAL 等）严格被保护，绝对未被删除
  assert.ok(existsSync(join(tasksDir, 'TASK-RUNNING-1.json')), 'RUNNING task must NEVER be deleted');
  assert.ok(existsSync(join(tasksDir, 'TASK-REVIEW-1.json')), 'REVIEW task must NEVER be deleted');
  assert.ok(existsSync(join(tasksDir, 'TASK-HUMAN-1.json')), 'WAITING_HUMAN task must NEVER be deleted');
  assert.ok(existsSync(join(tasksDir, 'TASK-WAITING-EXT-1.json')), 'WAITING_EXTERNAL task must NEVER be deleted');

  rmSync(tasksDir, { recursive: true, force: true });
});

test('TEST OPS-M5: logs rotate 不改变事件内容', async () => {
  const dir = tmpDir('af-ops-m5-');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');
  const archiveDir = join(dir, 'archive');

  const now = new Date('2026-09-07T12:00:00.000Z');

  // 创建历史事件（10天前）与近期事件（1天前）
  const oldEvent1 = {
    executor: 'antigravity',
    event: 'CIRCUIT_OPEN',
    reason: 'OLD_ERROR_403',
    timestamp: '2026-08-28T00:00:00.000Z',
  };
  const oldEvent2 = {
    executor: 'antigravity',
    event: 'LAUNCH_BLOCKED',
    circuit_state: 'OPEN_MANUAL_RESET',
    timestamp: '2026-08-29T10:00:00.000Z',
  };
  const recentEvent = {
    executor: 'claude',
    event: 'CIRCUIT_RESET',
    reset_by: 'alice',
    reason: 'routine reset',
    timestamp: '2026-09-06T15:00:00.000Z',
  };

  const originalLines = [
    JSON.stringify(oldEvent1),
    JSON.stringify(oldEvent2),
    JSON.stringify(recentEvent),
  ];

  writeFileSync(eventsLogFile, originalLines.join('\n') + '\n', 'utf8');

  // 执行 7 天日志轮转
  const res = rotateLogs({ eventsLogFile, archiveDir, days: 7, now });
  assert.strictEqual(res.rotated, true);
  assert.strictEqual(res.archived_count, 2);
  assert.strictEqual(res.retained_count, 1);
  assert.ok(existsSync(res.archive_file), 'Archive file must exist');

  // 1. 验证旧事件移入 archive，且原始内容一字不差
  const archiveLines = readFileSync(res.archive_file, 'utf8').trim().split('\n');
  assert.strictEqual(archiveLines.length, 2);
  assert.strictEqual(archiveLines[0], originalLines[0], 'Old event 1 content must be unchanged byte-for-byte');
  assert.strictEqual(archiveLines[1], originalLines[1], 'Old event 2 content must be unchanged byte-for-byte');

  // 2. 验证当前活动日志只保留最近事件，且原始内容一字不差
  const retainedLines = readFileSync(eventsLogFile, 'utf8').trim().split('\n');
  assert.strictEqual(retainedLines.length, 1);
  assert.strictEqual(retainedLines[0], originalLines[2], 'Recent event content must be unchanged byte-for-byte');

  // 3. 再次轮转（无更旧事件），验证幂等
  const res2 = rotateLogs({ eventsLogFile, archiveDir, days: 7, now });
  assert.strictEqual(res2.rotated, false);
  assert.strictEqual(res2.archived_count, 0);

  rmSync(dir, { recursive: true, force: true });
});

test('TEST OPS-M6: 冷却状态投影 OPEN_COOLDOWN 到期显示 HALF_OPEN_PENDING (无自动transition)', async () => {
  const dir = tmpDir('af-ops-m6-');
  const execDir = makeExecDir(dir);
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(policyFile, JSON.stringify({
    claude: { max_parallel: 1, min_interval_ms: 10, cooldown_ms: 5000 },
  }));
  writeFileSync(stateFile, JSON.stringify({
    claude: {
      state: 'OPEN_COOLDOWN',
      category: 'RATE_LIMIT',
      reason: 'rate limit reached',
      opened_at: '2026-09-07T00:00:00.000Z',
      cooldown_until: '2026-09-07T00:00:05.000Z',
    },
  }));

  const guard = new ExecutorRuntimeGuard({ policyFile, stateFile, eventsLogFile });

  // 1. 当 now < cooldown_until: 显示 OPEN_COOLDOWN
  const listBefore = listCircuitBreakers({
    runtimeGuard: guard,
    executorsDir: execDir,
    now: '2026-09-07T00:00:02.000Z',
  });
  const claudeBefore = listBefore.find((i) => i.id === 'claude');
  assert.strictEqual(claudeBefore.state, 'OPEN_COOLDOWN');

  // 2. 当 now >= cooldown_until: 投影显示为 HALF_OPEN_PENDING
  const listAfter = listCircuitBreakers({
    runtimeGuard: guard,
    executorsDir: execDir,
    now: '2026-09-07T00:00:10.000Z',
  });
  const claudeAfter = listAfter.find((i) => i.id === 'claude');
  assert.strictEqual(claudeAfter.state, 'HALF_OPEN_PENDING');

  // 3. 验证禁止自动 transition：guard 内部持久化状态仍然是 OPEN_COOLDOWN
  const rawDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.strictEqual(rawDisk.claude.state, 'OPEN_COOLDOWN', 'Must not automatically mutate state file');

  rmSync(dir, { recursive: true, force: true });
});
