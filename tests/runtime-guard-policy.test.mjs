// tests/runtime-guard-policy.test.mjs - runtime guard policy & operator view
//
//   GP-1: per-executor policy is DEEP merged, so a profile that overrides one
//         knob does not drop the executor's other safety limits (antigravity
//         must keep its 1h cooldown)
//   GP-2: cooldown_until is epoch ms regardless of the form stored on disk
//   GP-3: a launch blocked by the guard is an ENVIRONMENT_FAULT, never a
//         fabricated ACCOUNT_POLICY
//   GP-4: codex acquires its slot with a purpose, so a recovery probe can run

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './helpers/runtime-state-fixture.mjs';
import './helpers/executors-fixture.mjs';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ------------------------------------------------------------------ GP-1
test('GP-1: 逐 executor 深合并策略，antigravity 的 1h 冷却不被覆盖', () => {
  const dir = tmpDir('af-gp1-');
  try {
    const policyFile = join(dir, 'profiles.json');
    // The shipped profile shape: per-executor, and it does not repeat cooldown_ms.
    writeFileSync(policyFile, JSON.stringify({
      antigravity: { max_parallel: 1, min_interval_ms: 5000 },
      claude: { max_parallel: 2 },
    }));

    const guard = new ExecutorRuntimeGuard({
      policyFile,
      stateFile: join(dir, 'state.json'),
      eventsLogFile: join(dir, 'events.jsonl'),
    });

    assert.strictEqual(guard.getPolicy('antigravity').cooldown_ms, 3600000, 'antigravity keeps its 1h cooldown');
    assert.strictEqual(guard.getPolicy('antigravity').min_interval_ms, 5000);
    assert.strictEqual(guard.getPolicy('antigravity').max_parallel, 1);
    assert.strictEqual(guard.getPolicy('claude').cooldown_ms, 60000, 'claude keeps the default cooldown');
    assert.strictEqual(guard.getPolicy('codex').min_interval_ms, 2000, 'an executor absent from the file keeps its defaults');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ GP-2
test('GP-2: 磁盘上的 ISO 冷却时间被归一为 epoch ms', () => {
  const dir = tmpDir('af-gp2-');
  try {
    const now = Date.parse('2026-09-16T00:00:00.000Z');
    const stateFile = join(dir, 'state.json');
    writeFileSync(stateFile, JSON.stringify({
      claude: {
        state: 'OPEN_COOLDOWN',
        category: 'RATE_LIMIT',
        reason: '429',
        opened_at: new Date(now - 60000).toISOString(),
        cooldown_until: '2026-09-15T23:59:00.000Z', // ISO string from an older build
      },
    }));

    const guard = new ExecutorRuntimeGuard({
      stateFile,
      eventsLogFile: join(dir, 'events.jsonl'),
      now: () => now,
    });

    const c = guard.getCircuitState('claude');
    assert.strictEqual(typeof c.cooldown_until, 'number', 'cooldown must be normalized to epoch ms');
    assert.strictEqual(c.cooldown_until, Date.parse('2026-09-15T23:59:00.000Z'));

    // The elapsed cooldown is therefore correctly projected at the point of use.
    assert.strictEqual(guard.canExecute('claude'), false);
    assert.strictEqual(guard.getCircuitState('claude').state, 'HALF_OPEN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ GP-3
test('GP-3: 被护栏拦截的发射不得伪造成 ACCOUNT_POLICY', async () => {
  const { runtimeGuard } = await import('../lib/executor-runtime-guard.mjs');
  const { ADAPTERS } = await import('../lib/adapters.mjs');

  runtimeGuard.recordResult('codex', {
    category: 'ACCOUNT_POLICY',
    retryable: false,
    safety_action: 'OPEN_MANUAL_RESET',
    reason: '403 TOS_VIOLATION',
  });

  try {
    assert.strictEqual(runtimeGuard.getCircuitState('codex').state, 'OPEN_MANUAL_RESET');

    const result = await ADAPTERS.codex.run({
      task_id: 'TASK-GP3',
      assigned_role: 'author',
      prompt: 'must never spawn',
      cwd: tmpdir(),
      timeout_ms: 5000,
    });

    assert.match(String(result.error_classification?.reason), /EXECUTOR_CIRCUIT_OPEN/,
      'the refusal must be the circuit, not a spawn failure');
    assert.strictEqual(result.error_classification?.category, 'ENVIRONMENT_FAULT');
    assert.notStrictEqual(result.error_classification?.category, 'ACCOUNT_POLICY');
    assert.strictEqual(result.error_classification?.safety_action, 'NONE');
  } finally {
    runtimeGuard.resetCircuit('codex', { reset_by: 'test', reason: 'GP-3 cleanup' });
  }
});

// ------------------------------------------------------------------ GP-4
test('GP-4: recovery_probe 目的能穿过熔断（codex 发射确实带上了 purpose）', async () => {
  const { runtimeGuard } = await import('../lib/executor-runtime-guard.mjs');
  const { ADAPTERS } = await import('../lib/adapters.mjs');
  const dir = tmpDir('af-gp4-');

  runtimeGuard.recordResult('codex', {
    category: 'ACCOUNT_POLICY',
    retryable: false,
    safety_action: 'OPEN_MANUAL_RESET',
    reason: '403 TOS_VIOLATION',
  });
  runtimeGuard.startProbe('codex');

  try {
    assert.strictEqual(runtimeGuard.getCircuitState('codex').state, 'PROBING');

    // A production run is refused by the circuit ...
    const production = await ADAPTERS.codex.run({
      task_id: 'TASK-GP4-PROD',
      assigned_role: 'author',
      prompt: 'x',
      cwd: dir,
      timeout_ms: 5000,
    });
    assert.match(String(production.error_classification?.reason), /EXECUTOR_CIRCUIT_OPEN/);

    // ... while a recovery probe is admitted, which only holds if the adapter
    // forwards its purpose to acquireSlot.
    const probe = await ADAPTERS.codex.run({
      task_id: 'TASK-GP4-PROBE',
      assigned_role: 'author',
      prompt: 'x',
      cwd: dir,
      timeout_ms: 5000,
      purpose: 'recovery_probe',
    });
    assert.doesNotMatch(
      String(probe.error_classification?.reason ?? ''),
      /EXECUTOR_CIRCUIT_OPEN/,
      'a recovery probe must not be blocked by the circuit it is probing'
    );
  } finally {
    runtimeGuard.resetCircuit('codex', { reset_by: 'test', reason: 'GP-4 cleanup' });
    rmSync(dir, { recursive: true, force: true });
  }
});
