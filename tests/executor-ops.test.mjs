// executor-ops.test.mjs - PHASE 5-B Executor Operations Layer tests
//
// Tests:
//   TEST OPS-A: status query correctly reads capability, availability, runtime
//   TEST OPS-B: OPEN_MANUAL_RESET state forbids launch (records LAUNCH_BLOCKED)
//   TEST OPS-C: reset must be manually called (rejects without reason, no auto reset)
//   TEST OPS-D: reset records audit evidence (state last_reset + CIRCUIT_RESET audit event)
//   TEST OPS-E: agy circuit open does not affect claude (executor isolation)

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
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

test('TEST OPS-A: status query correctly reads capability, availability, runtime', async () => {
  const dir = tmpDir('af-ops-a-');
  const execDir = makeExecDir(dir);
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
    claude: { max_parallel: 2, min_interval_ms: 10 },
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

  // 1. Query antigravity status
  const agyStatus = getExecutorOperationsStatus('antigravity', { executorsDir: execDir, runtimeGuard: guard });
  assert.strictEqual(agyStatus.executor, 'antigravity');
  assert.strictEqual(agyStatus.capability, 'READY');
  assert.strictEqual(agyStatus.availability, 'ACCOUNT_DISABLED_403');
  assert.strictEqual(agyStatus.runtime, 'OPEN_MANUAL_RESET');
  assert.strictEqual(agyStatus.circuit, 'OPEN');
  assert.strictEqual(agyStatus.last_failure, 'ACCOUNT_POLICY');
  assert.strictEqual(agyStatus.reset_required, true);

  // Verify format matches specification
  const formattedAgy = formatExecutorStatus(agyStatus);
  assert.match(formattedAgy, /executor:\nantigravity/);
  assert.match(formattedAgy, /capability:\nREADY/);
  assert.match(formattedAgy, /availability:\nACCOUNT_DISABLED_403/);
  assert.match(formattedAgy, /runtime:\nOPEN_MANUAL_RESET/);
  assert.match(formattedAgy, /circuit:\nOPEN/);
  assert.match(formattedAgy, /last_failure:\nACCOUNT_POLICY/);
  assert.match(formattedAgy, /reset_required:\ntrue/);

  // 2. Query claude status (healthy executor)
  const claudeStatus = getExecutorOperationsStatus('claude', { executorsDir: execDir, runtimeGuard: guard });
  assert.strictEqual(claudeStatus.executor, 'claude');
  assert.strictEqual(claudeStatus.capability, 'READY');
  assert.strictEqual(claudeStatus.availability, 'AVAILABLE');
  assert.strictEqual(claudeStatus.runtime, 'CLOSED');
  assert.strictEqual(claudeStatus.circuit, 'CLOSED');
  assert.strictEqual(claudeStatus.reset_required, false);

  // 3. Query using alias 'agy' resolves to 'antigravity'
  const aliasStatus = getExecutorOperationsStatus('agy', { executorsDir: execDir, runtimeGuard: guard });
  assert.strictEqual(aliasStatus.executor, 'antigravity');
  assert.strictEqual(aliasStatus.runtime, 'OPEN_MANUAL_RESET');

  rmSync(dir, { recursive: true, force: true });
});

test('TEST OPS-B: OPEN_MANUAL_RESET state forbids launch (records LAUNCH_BLOCKED)', async () => {
  const dir = tmpDir('af-ops-b-');
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

  // Verify launch is forbidden
  assert.strictEqual(guard.canExecute('antigravity'), false);

  await assert.rejects(
    async () => { await guard.acquireSlot('antigravity'); },
    (err) => {
      assert.strictEqual(err.code, 'CIRCUIT_OPEN');
      assert.match(err.message, /OPEN_MANUAL_RESET/);
      return true;
    }
  );

  // Verify audit event log recorded LAUNCH_BLOCKED
  const events = readRuntimeAuditEvents({ eventsLogFile });
  assert.ok(events.length >= 1, 'at least one audit event logged');
  const blockedEvent = events.find((e) => e.event === 'LAUNCH_BLOCKED');
  assert.ok(blockedEvent, 'LAUNCH_BLOCKED event must be recorded');
  assert.strictEqual(blockedEvent.executor, 'antigravity');
  assert.strictEqual(blockedEvent.circuit_state, 'OPEN_MANUAL_RESET');
  assert.ok(blockedEvent.timestamp, 'timestamp must be present');

  rmSync(dir, { recursive: true, force: true });
});

test('TEST OPS-C: reset must be manually called (rejects without reason, no auto reset)', async () => {
  const dir = tmpDir('af-ops-c-');
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

  // 1. Verify no auto-reset over multiple queries
  for (let i = 0; i < 5; i++) {
    const c = guard.getCircuitState('antigravity');
    assert.strictEqual(c.state, 'OPEN_MANUAL_RESET');
    assert.strictEqual(guard.canExecute('antigravity'), false);
  }

  // 2. Calling reset without reason must fail
  assert.throws(
    () => { resetCircuitBreaker('antigravity', { reason: '', runtimeGuard: guard }); },
    (err) => {
      assert.match(err.message, /--reason is required/);
      return true;
    }
  );

  assert.throws(
    () => { resetCircuitBreaker('antigravity', { runtimeGuard: guard }); },
    (err) => {
      assert.match(err.message, /--reason is required/);
      return true;
    }
  );

  // Verify circuit is still OPEN_MANUAL_RESET after failed attempts
  assert.strictEqual(guard.canExecute('antigravity'), false);
  assert.strictEqual(guard.getCircuitState('antigravity').state, 'OPEN_MANUAL_RESET');

  // 3. Manual reset with reason succeeds
  const res = resetCircuitBreaker('antigravity', {
    reason: 'manual verification after account recovery',
    reset_by: 'operator-charlie',
    runtimeGuard: guard,
  });
  assert.strictEqual(res.state, 'CLOSED');
  assert.strictEqual(guard.canExecute('antigravity'), true);

  rmSync(dir, { recursive: true, force: true });
});

test('TEST OPS-D: reset records audit evidence (state last_reset + CIRCUIT_RESET audit event)', async () => {
  const dir = tmpDir('af-ops-d-');
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
    reason: 'operator unblock confirmed',
    reset_by: 'operator-dave',
    runtimeGuard: guard,
  });

  // 1. In-memory circuit state has last_reset
  const c = guard.getCircuitState('antigravity');
  assert.strictEqual(c.state, 'CLOSED');
  assert.strictEqual(c.last_reset.reset_by, 'operator-dave');
  assert.strictEqual(c.last_reset.reason, 'operator unblock confirmed');
  assert.ok(c.last_reset.reset_time);

  // 2. Persisted state on disk has last_reset
  const diskState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.strictEqual(diskState.antigravity.state, 'CLOSED');
  assert.strictEqual(diskState.antigravity.last_reset.reset_by, 'operator-dave');
  assert.strictEqual(diskState.antigravity.last_reset.reason, 'operator unblock confirmed');
  assert.strictEqual(diskState.antigravity.last_reset.reset_time, c.last_reset.reset_time);

  // 3. Event log has CIRCUIT_RESET event
  const events = readRuntimeAuditEvents({ eventsLogFile });
  const resetEvent = events.find((e) => e.event === 'CIRCUIT_RESET');
  assert.ok(resetEvent, 'CIRCUIT_RESET event must be present in log');
  assert.strictEqual(resetEvent.executor, 'antigravity');
  assert.strictEqual(resetEvent.reset_by, 'operator-dave');
  assert.strictEqual(resetEvent.reason, 'operator unblock confirmed');
  assert.strictEqual(resetEvent.timestamp, c.last_reset.reset_time);

  // 4. Verify ZERO forbidden fields (prompt, response, token, credential) across all events
  const FORBIDDEN_FIELDS = ['prompt', 'response', 'token', 'credential', 'password', 'key', 'secret'];
  for (const event of events) {
    for (const key of Object.keys(event)) {
      assert.ok(!FORBIDDEN_FIELDS.includes(key.toLowerCase()), `Forbidden field "${key}" found in audit event log`);
    }
  }

  rmSync(dir, { recursive: true, force: true });
});

test('TEST OPS-E: agy circuit open does not affect claude (executor isolation)', async () => {
  const dir = tmpDir('af-ops-e-');
  const execDir = makeExecDir(dir);
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(policyFile, JSON.stringify({
    antigravity: { max_parallel: 1, min_interval_ms: 10 },
    claude: { max_parallel: 2, min_interval_ms: 10 },
    codex: { max_parallel: 1, min_interval_ms: 10 },
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

  // 1. List circuit breakers
  const list = listCircuitBreakers({ runtimeGuard: guard, executorsDir: execDir });
  const agyItem = list.find((i) => i.id === 'antigravity');
  const claudeItem = list.find((i) => i.id === 'claude');
  const codexItem = list.find((i) => i.id === 'codex');

  assert.strictEqual(agyItem.state, 'OPEN_MANUAL_RESET');
  assert.strictEqual(claudeItem.state, 'CLOSED');
  assert.strictEqual(codexItem.state, 'CLOSED');

  // Format circuit list
  const formatted = formatCircuitList(list);
  assert.match(formatted, /agy:\nOPEN_MANUAL_RESET/);
  assert.match(formatted, /claude:\nCLOSED/);
  assert.match(formatted, /codex:\nCLOSED/);

  // 2. Antigravity launch is blocked
  assert.strictEqual(guard.canExecute('antigravity'), false);
  await assert.rejects(
    async () => { await guard.acquireSlot('antigravity'); },
    (err) => err.code === 'CIRCUIT_OPEN'
  );

  // 3. Claude launch is completely unaffected
  assert.strictEqual(guard.canExecute('claude'), true);
  await guard.acquireSlot('claude');
  assert.strictEqual(guard.activeProcesses.get('claude'), 1);
  guard.releaseSlot('claude');
  assert.strictEqual(guard.activeProcesses.get('claude'), 0);

  // 4. Codex launch is completely unaffected
  assert.strictEqual(guard.canExecute('codex'), true);
  await guard.acquireSlot('codex');
  assert.strictEqual(guard.activeProcesses.get('codex'), 1);
  guard.releaseSlot('codex');
  assert.strictEqual(guard.activeProcesses.get('codex'), 0);

  rmSync(dir, { recursive: true, force: true });
});
