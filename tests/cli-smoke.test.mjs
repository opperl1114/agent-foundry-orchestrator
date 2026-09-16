// tests/cli-smoke.test.mjs - the operator-facing entrypoints actually run
//
// Everything else in the suite imports a module and calls its functions. That
// leaves the CLI layer unexecuted: a broken argv handler, a command that cannot
// start, or an uncaught exception printed as a raw stack trace would all pass.
// (It did: `orchestrator status --task-id <unknown>` threw before this test
// existed.) Each case runs the real entrypoint in a child process.
//
// The child is given temporary runtime paths so the repository is untouched.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = mkdtempSync(join(tmpdir(), 'af-cli-'));
process.on('exit', () => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

function cli(script, args) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      AF_TASKS_DIR: join(SANDBOX, 'tasks'),
      AF_EXECUTORS_DIR: join(ROOT, 'fixtures', 'agent-foundry-global', 'executors'),
      AF_SAFETY_STATE_FILE: join(SANDBOX, 'safety-state.json'),
      AF_RUNTIME_EVENTS_LOG: join(SANDBOX, 'events.jsonl'),
    },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const NO_STACK_TRACE = /^\s+at |node:internal\/modules|file:\/\/\//m;

// ------------------------------------------------------------------ CLI-1
test('CLI-1: status 对不存在的任务给出干净错误，而不是裸栈', () => {
  const r = cli('orchestrator.mjs', ['status', '--task-id', 'TASK-DOES-NOT-EXIST']);
  assert.strictEqual(r.code, 2, `expected a clean exit 2, got ${r.code}`);
  assert.match(r.err, /task not found/);
  assert.doesNotMatch(r.err, NO_STACK_TRACE, 'an unknown task must not print a stack trace');
});

// ------------------------------------------------------------------ CLI-2
test('CLI-2: inspect 与 cancel 对不存在的任务同样干净失败', () => {
  for (const cmd of ['inspect', 'cancel']) {
    const r = cli('orchestrator.mjs', [cmd, '--task-id', 'TASK-DOES-NOT-EXIST']);
    assert.strictEqual(r.code, 2, `${cmd}: expected exit 2, got ${r.code}`);
    assert.match(r.err, /task not found/, `${cmd}: expected a clear message`);
    assert.doesNotMatch(r.err, NO_STACK_TRACE, `${cmd}: must not print a stack trace`);
  }
});

// ------------------------------------------------------------------ CLI-3
test('CLI-3: recover --scan 可运行且无副作用', () => {
  const r = cli('orchestrator.mjs', ['recover', '--scan']);
  assert.strictEqual(r.code, 0, r.err.slice(0, 300));
  assert.match(r.out, /scan complete/);
});

// ------------------------------------------------------------------ CLI-4
test('CLI-4: af-admin circuit list 可运行', () => {
  const r = cli('af-admin.mjs', ['circuit', 'list']);
  assert.strictEqual(r.code, 0, r.err.slice(0, 300));
  assert.match(r.out, /claude/, 'every known executor must be listed');
  assert.doesNotMatch(r.out, /undefined/, 'the listing must not leak undefined fields');
});

// ------------------------------------------------------------------ CLI-5
test('CLI-5: af-admin executor status 读取能力真源', () => {
  const r = cli('af-admin.mjs', ['executor', 'status', 'claude']);
  assert.strictEqual(r.code, 0, r.err.slice(0, 300));
  assert.match(r.out, /capability:\nREADY/, 'the fixture registry must project READY');
});
