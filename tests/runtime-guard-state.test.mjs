// tests/runtime-guard-state.test.mjs - circuit state durability & fail-closed
//
//   CS-1: circuit state is written atomically (no half-written file on a crash)
//   CS-2: an unreadable state file fails CLOSED (every breaker opens, verdict
//         quarantined, audit event recorded) instead of silently reopening them
//   CS-3: getCircuitState is a pure read (a query does not write to disk)
//   CS-4: an elapsed cooldown is projected to HALF_OPEN at the point of use
//
// Every case drives an explicit temporary state/log file, so the real
// runtime/executor-safety-state.json is never touched.

import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './helpers/executors-fixture.mjs';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';

function stateDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeGuard(dir, over = {}) {
  return new ExecutorRuntimeGuard({
    stateFile: join(dir, 'executor-safety-state.json'),
    eventsLogFile: join(dir, 'events.jsonl'),
    ...over,
  });
}

// ------------------------------------------------------------------ CS-1
test('CS-1: 熔断状态写入是原子的（先写临时文件再 rename）', () => {
  const dir = stateDir('af-cs1-');
  try {
    const guard = makeGuard(dir);
    guard.recordResult('claude', {
      category: 'ACCOUNT_POLICY',
      retryable: false,
      safety_action: 'OPEN_MANUAL_RESET',
      reason: '403',
    });

    const file = join(dir, 'executor-safety-state.json');
    assert.ok(existsSync(file), 'state file must exist');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.claude.state, 'OPEN_MANUAL_RESET');

    // No leftover temp siblings: the rename replaced the target atomically.
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepStrictEqual(leftovers, [], 'no temporary write files may remain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ CS-2
test('CS-2: 状态文件损坏时 fail-closed（全部熔断，且不静默放行）', () => {
  const dir = stateDir('af-cs2-');
  try {
    const file = join(dir, 'executor-safety-state.json');
    // A healthy OPEN_MANUAL_RESET for claude, then truncated on write.
    writeFileSync(file, '{"claude": {"state": "OPEN_MANUAL_RESET"');

    const guard = makeGuard(dir);

    for (const id of ['claude', 'codex', 'antigravity', 'vertex-gemini', 'cline']) {
      assert.strictEqual(
        guard.getCircuitState(id).state,
        'OPEN_MANUAL_RESET',
        `${id} must fail closed when the state file is unreadable`
      );
      assert.strictEqual(guard.canExecute(id), false, `${id} must not be launchable`);
    }

    const quarantined = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.strictEqual(quarantined.length, 1, 'the unreadable state must be kept as evidence');

    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    assert.match(events, /STATE_CORRUPTION/, 'a STATE_CORRUPTION audit event must be recorded');

    const rewritten = JSON.parse(readFileSync(file, 'utf8'));
    assert.strictEqual(rewritten.claude.state, 'OPEN_MANUAL_RESET');
    assert.strictEqual(rewritten.claude.category, 'STATE_CORRUPTION');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ CS-3
test('CS-3: getCircuitState 是纯读（查询不落盘）', () => {
  const dir = stateDir('af-cs3-');
  try {
    const file = join(dir, 'executor-safety-state.json');
    const guard = makeGuard(dir);
    guard.recordResult('claude', {
      category: 'ACCOUNT_POLICY',
      retryable: false,
      safety_action: 'OPEN_MANUAL_RESET',
      reason: '403',
    });

    const before = statSync(file).mtimeMs;
    const snapshot = readFileSync(file, 'utf8');

    for (let i = 0; i < 5; i += 1) guard.getCircuitState('claude');

    assert.strictEqual(readFileSync(file, 'utf8'), snapshot, 'a read must not change the state file');
    assert.strictEqual(statSync(file).mtimeMs, before, 'a read must not rewrite the state file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ CS-4
test('CS-4: 冷却到期在“使用时”投影为 HALF_OPEN 并落盘一次', () => {
  const dir = stateDir('af-cs4-');
  try {
    const now = Date.now();
    let clock = now;
    const file = join(dir, 'executor-safety-state.json');
    writeFileSync(file, JSON.stringify({
      claude: {
        state: 'OPEN_COOLDOWN',
        category: 'RATE_LIMIT',
        reason: '429',
        opened_at: new Date(now - 120000).toISOString(),
        cooldown_until: now - 1000, // already elapsed
      },
    }));

    const guard = makeGuard(dir, { now: () => clock });

    // A pure read must report the stored state ...
    assert.strictEqual(guard.getCircuitState('claude').state, 'OPEN_COOLDOWN');

    // ... and the point-of-use projection performs the single transition.
    clock = now;
    assert.strictEqual(guard.canExecute('claude'), false, 'HALF_OPEN is not launchable');
    assert.strictEqual(guard.getCircuitState('claude').state, 'HALF_OPEN');
    assert.strictEqual(JSON.parse(readFileSync(file, 'utf8')).claude.state, 'HALF_OPEN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
