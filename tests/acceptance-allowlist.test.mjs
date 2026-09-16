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
  verifyAcceptanceBinding,
  loadAcceptanceAllowlist,
} from '../lib/acceptance.mjs';
import { Scheduler } from '../lib/scheduler.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every temp dir this file creates is removed when the process exits: a test
// that only cleans up on its happy path (or that creates a fixture inside a
// helper like boundTask) still leaves the directory behind on /tmp.
const createdDirs = [];
process.on('exit', () => {
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
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

// ------------------------------------------------------------------ ACC-7
test('ACC-7: legacy 字符串通道已关闭（即使任务文件显式开启）', async () => {
  // Report H1: the legacy branch returned before any whitelist check, so this
  // task file pair executed an arbitrary shell.
  assert.throws(
    () => normalizeAcceptanceCmd('id -un; echo pwned', { allowLegacy: true }),
    /acceptance_command_not_allowlisted/
  );

  const task = boundTask({
    acceptance_cmd: 'id -un; echo pwned',
    allow_legacy_shell_acceptance: true,
  });
  const res = await runAcceptance(task);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.record.failure_reason, 'ACCEPTANCE_COMMAND_REJECTED');
  assert.doesNotMatch(String(res.output), /pwned/, 'the shell must never have run');
});

// ------------------------------------------------------------------ ACC-8
test('ACC-8: 删掉 acceptance_binding 必须 fail-closed，而不是解绑信任锚', async () => {
  // Report H2: a missing binding was treated as acceptable, and the scheduler
  // re-bound whatever it found, so deleting one field bypassed the anchor.
  assert.strictEqual(verifyAcceptanceBinding({ acceptance_cmd: { command: 'node', args: ['--test', 'x'] } }).ok, false);

  const work = tmpDir('af-acc8-');
  const sched = new Scheduler({ tasksDir: work });
  sched.enqueue({
    task_id: 'TASK-ACC8',
    goal: 'g',
    acceptance: 'a',
    fixture_dir: work,
    acceptance_cmd: { command: 'node', args: ['--test', 'ok.test.mjs'] },
    author_executor: 'auto',
    reviewer_executor: 'auto',
  });

  const file = join(work, 'TASK-ACC8.json');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(onDisk.acceptance_binding, 'enqueue must bind the anchor');
  delete onDisk.acceptance_binding; // the attack: remove the field
  writeFileSync(file, JSON.stringify(onDisk, null, 2));

  sched.runNext();
  await sched.waitAll();

  const settled = JSON.parse(readFileSync(file, 'utf8'));
  assert.strictEqual(settled.state, 'FAILED');
  assert.strictEqual(settled.failure_reason, 'TASK_FILE_TAMPERED');
  assert.strictEqual(settled.runs.length, 0, 'no executor may be spent on an unbound anchor');
});

// ------------------------------------------------------------------ ACC-9
test('ACC-9: 白名单按完整命令匹配，basename 相同的任意路径不得放行', () => {
  // Extra hole found while verifying the report: isAllowed compared basenames,
  // so any file called "node" anywhere on disk satisfied the "node" entry.
  assert.throws(
    () => normalizeAcceptanceCmd({ command: '/tmp/somewhere-else/node', args: ['--test'] }),
    /acceptance_command_not_allowlisted/
  );
  // An entry naming an explicit path still has to be named exactly.
  assert.strictEqual(
    normalizeAcceptanceCmd({ command: 'node', args: ['--test'] }).command,
    'node'
  );
});

// ------------------------------------------------------------------ ACC-10
test('ACC-10: 挂住的验收命令会被超时终止（不再永久卡死任务）', { timeout: 30000 }, async () => {
  // Report H3: runAcceptance had no timeout, no kill, and was invisible to the
  // shutdown reclamation.
  const dir = tmpDir('af-acc10-');
  writeFileSync(join(dir, 'hang.test.mjs'),
    "import { test } from 'node:test';\ntest('hang forever', async () => { await new Promise(() => {}); });\n");

  const task = boundTask({
    fixture_dir: dir,
    acceptance_cmd: { command: 'node', args: ['--test', 'hang.test.mjs'] },
    acceptance_timeout_ms: 1500,
  });

  const started = Date.now();
  const res = await runAcceptance(task);
  const elapsed = Date.now() - started;

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.record.failure_reason, 'timeout');
  assert.ok(elapsed < 20000, `the timeout must settle the run (took ${elapsed}ms)`);
});
