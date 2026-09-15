// tests/acceptance-allowlist.test.mjs - acceptance trust anchor hardening
//
// The acceptance command is a trust anchor: it is executed with the operator's
// privileges, yet its only validation used to be a shape check at submission.
//
//   ACC-1: a command outside the allowlist is rejected and never spawned
//   ACC-2: an allowlisted command still runs
//   ACC-3: an anchor edited after binding is refused (TASK_FILE_TAMPERED)
//   ACC-4: the acceptance child does not inherit credential-like env vars
//   ACC-5: a workspace inside the orchestrator root is refused
//   ACC-6: the scheduler refuses a task whose anchor was edited on disk
//
// This file deliberately does NOT import the permissive test allowlist: these
// assertions are about the SHIPPED allowlist.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import './helpers/runtime-state-fixture.mjs';
import './helpers/executors-fixture.mjs';
import {
  runAcceptance,
  normalizeAcceptanceCmd,
  acceptanceBinding,
  loadAcceptanceAllowlist,
} from '../lib/acceptance.mjs';
import { Scheduler } from '../lib/scheduler.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function boundTask(over = {}) {
  const task = {
    task_id: 'TASK-ACC',
    acceptance_cmd: { command: 'node', args: ['--test', 'ok.test.mjs'] },
    fixture_dir: tmpDir('af-acc-'),
    ...over,
  };
  task.acceptance_binding = acceptanceBinding(task);
  return task;
}

// ------------------------------------------------------------------ ACC-1
test('ACC-1: 白名单外的验收命令被拒绝且不会执行', async () => {
  const shipped = loadAcceptanceAllowlist();
  assert.ok(shipped.length > 0, 'the shipped allowlist must not be empty');
  assert.ok(
    !shipped.some((e) => e.command === 'rm'),
    'the shipped allowlist must not permit arbitrary programs'
  );

  assert.throws(
    () => normalizeAcceptanceCmd({ command: 'rm', args: ['-rf', '/tmp/unused'] }),
    /acceptance_command_not_allowlisted/,
    'an unlisted command must be rejected at normalization'
  );
  assert.throws(
    () => normalizeAcceptanceCmd({ command: 'node', args: ['-e', 'process.exit(0)'] }),
    /acceptance_command_not_allowlisted/,
    'node with an unlisted argument prefix must be rejected'
  );

  const task = boundTask({ acceptance_cmd: { command: 'rm', args: ['-rf', '/tmp/unused'] } });
  const res = await runAcceptance(task);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.record.failure_reason, 'ACCEPTANCE_COMMAND_REJECTED');
});

// ------------------------------------------------------------------ ACC-2
test('ACC-2: 白名单内的验收命令照常执行', async () => {
  const dir = tmpDir('af-acc2-');
  try {
    writeFileSync(join(dir, 'ok.test.mjs'),
      "import { test } from 'node:test';\ntest('ok', () => {});\n");
    const task = boundTask({ fixture_dir: dir });
    const res = await runAcceptance(task);
    assert.strictEqual(res.ok, true, res.record?.stderr_summary ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ACC-3
test('ACC-3: 绑定后被篡改的验收锚点被拒绝', async () => {
  const task = boundTask();
  task.acceptance_cmd = { command: 'node', args: ['--test', 'other.test.mjs'] }; // edited after binding

  const res = await runAcceptance(task);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.record.failure_reason, 'TASK_FILE_TAMPERED');
});

// ------------------------------------------------------------------ ACC-4
test('ACC-4: 验收子进程不继承凭据类环境变量', async () => {
  const dir = tmpDir('af-acc4-');
  const previous = {
    MY_API_TOKEN: process.env.MY_API_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AF_ACCEPTANCE_ENV_MY_FLAG: process.env.AF_ACCEPTANCE_ENV_MY_FLAG,
  };
  process.env.MY_API_TOKEN = 'secret-value';
  process.env.ANTHROPIC_API_KEY = 'sk-secret-value';
  process.env.AF_ACCEPTANCE_ENV_MY_FLAG = 'yes';

  try {
    writeFileSync(join(dir, 'env.test.mjs'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "test('the acceptance child gets a scrubbed env', () => {",
      "  assert.strictEqual(process.env.MY_API_TOKEN, undefined, 'credential-like var must not leak');",
      "  assert.strictEqual(process.env.ANTHROPIC_API_KEY, undefined, 'api key must not leak');",
      "  assert.strictEqual(process.env.MY_FLAG, 'yes', 'AF_ACCEPTANCE_ENV_ passthrough must work');",
      "});",
      '',
    ].join('\n'));

    const task = boundTask({
      fixture_dir: dir,
      acceptance_cmd: { command: 'node', args: ['--test', 'env.test.mjs'] },
    });
    const res = await runAcceptance(task);
    assert.strictEqual(res.ok, true, res.record?.stderr_summary ?? '');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ACC-5
test('ACC-5: 工作区位于编排器根目录内时拒绝执行', async () => {
  const task = boundTask({ fixture_dir: join(ROOT_DIR, 'tests') });
  const res = await runAcceptance(task);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.record.failure_reason, 'FIXTURE_DIR_INSIDE_ORCHESTRATOR');
});

// ------------------------------------------------------------------ ACC-6
test('ACC-6: 调度器在磁盘上锚点被改写后拒绝执行（不重试）', { timeout: 30000 }, async () => {
  const work = tmpDir('af-acc6-');
  const taskId = 'TASK-ACC6';
  try {
    const sched = new Scheduler({ tasksDir: work });
    sched.enqueue({
      task_id: taskId,
      goal: 'g',
      acceptance: 'a',
      fixture_dir: work,
      acceptance_cmd: { command: 'node', args: ['--test', 'ok.test.mjs'] },
      author_executor: 'auto',
      reviewer_executor: 'auto',
    });

    const taskFile = join(work, `${taskId}.json`);
    const original = JSON.parse(readFileSync(taskFile, 'utf8'));
    assert.ok(original.acceptance_binding, 'enqueue must bind the acceptance anchor');

    // Tamper with the command after it was validated and bound.
    original.acceptance_cmd = { command: 'node', args: ['--test', 'attacker-chosen.test.mjs'] };
    writeFileSync(taskFile, JSON.stringify(original, null, 2));

    sched.runNext();
    await sched.waitAll();

    const settled = JSON.parse(readFileSync(taskFile, 'utf8'));
    assert.strictEqual(settled.state, 'FAILED');
    assert.strictEqual(settled.failure_reason, 'TASK_FILE_TAMPERED');
    assert.strictEqual(settled.error_classification?.retryable, false, 'tampering must never be retried');
    assert.strictEqual(settled.runs.length, 0, 'no executor may be spent on a tampered task');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
