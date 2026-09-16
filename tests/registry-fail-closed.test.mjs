// tests/registry-fail-closed.test.mjs - capability truth must be explicit
//
// This file deliberately does NOT import tests/helpers/executors-fixture.mjs:
// the ABSENCE of a capability registry is the condition under test. Previously
// a missing registry degraded silently - loadExecutorStatus()/loadCapabilityMap()
// returned empty maps and the router still dispatched along its priority order,
// as if the state of every executor were known.
//
//   REG-1: routing fails closed when no capability truth resolved
//   REG-2: the scheduler refuses to start a task in that state
//   REG-3: the shipped code contains no author-machine hardcoded path

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import './helpers/runtime-state-fixture.mjs';
import './helpers/acceptance-allowlist.mjs';
import { EXECUTORS_DIR } from '../lib/config.mjs';
import { resolveExecutorRoute } from '../lib/executor-router.mjs';
import { Scheduler } from '../lib/scheduler.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const registryConfigured = !!EXECUTORS_DIR && existsSync(EXECUTORS_DIR);
const skipReason = registryConfigured
  ? 'a real capability registry is configured on this host (AF_EXECUTORS_DIR / sibling checkout)'
  : false;

// ------------------------------------------------------------------ REG-1
test('REG-1: 缺少能力真源时路由 fail-closed，不静默按优先级派发', { skip: skipReason }, () => {
  assert.strictEqual(EXECUTORS_DIR, '', 'this host must resolve no capability registry for this test to apply');
  const route = resolveExecutorRoute({});
  assert.strictEqual(route.primary, null, 'no executor may be selected without capability truth');
  assert.deepStrictEqual(route.fallbacks, []);
  assert.match(String(route.reason), /EXECUTOR_REGISTRY_MISSING/);
});

// ------------------------------------------------------------------ REG-2
test('REG-2: 缺少能力真源时调度器拒绝启动任务（不消耗执行器）', { skip: skipReason }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'af-reg2-'));
  try {
    const sched = new Scheduler({
      tasksDir: work,
      adapters: {
        claude: {
          type: 'claude', supportsMcpUnattended: true, calls: [],
          async run() { this.calls.push('run'); throw new Error('must never be called'); },
          async resume() { throw new Error('must never be called'); },
          cancel() { return { requested: true }; },
        },
      },
    });

    sched.enqueue({
      task_id: 'TASK-REG2',
      goal: 'must not start without capability truth',
      acceptance: 'a',
      fixture_dir: work,
      author_executor: 'claude',
      reviewer_executor: 'claude',
    });

    sched.runNext();
    await sched.waitAll();

    const task = JSON.parse(readFileSync(join(work, 'TASK-REG2.json'), 'utf8'));
    assert.strictEqual(task.state, 'FAILED');
    assert.match(String(task.failure_reason), /EXECUTOR_REGISTRY_MISSING/);
    assert.strictEqual(task.runs.length, 0, 'no executor may be spent when the registry is missing');
    assert.strictEqual(task.retryable, false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ REG-3
test('REG-3: 出厂代码中不含作者机硬编码路径', () => {
  const files = [
    'lib/config.mjs',
    'lib/executor-status.mjs',
    'lib/executor-router.mjs',
    'bin/cline-af',
    'bin/vertex-gemini-af',
    'bin/af-admin',
    'af-admin.mjs',
  ];

  const offenders = [];
  for (const rel of files) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (/\/mnt\/c\/Users\/|\/home\/relaret/.test(text)) offenders.push(rel);
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `shipped files must not hardcode an author-machine path: ${offenders.join(', ')}`
  );
});
