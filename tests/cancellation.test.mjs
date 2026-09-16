// cancellation.test.mjs - PHASE 4 Closure: active executor cancellation
// C1: cancel(runId) precisely terminates a hanging run -> task CANCELLED
// C2: cancel A while B runs -> A CANCELLED, B COMPLETED (isolation)
// C3: cancel with no active process (already exited) -> CANCELLED, no error
import { test } from 'node:test';
import './helpers/tasks-dir-fixture.mjs';
import './helpers/executors-fixture.mjs';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';
import './helpers/runtime-state-fixture.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { saveTaskAtomic } from '../lib/store.mjs';
import './helpers/acceptance-allowlist.mjs';

const WORK = mkdtempSync(join(tmpdir(), 'af-p4c-work-'));
after(() => { rmSync(WORK, { recursive: true, force: true }); });

let n = 0;
// Hanging fake with per-run resolvers. cancel(runId) resolves exactly one run.
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
      const runId = capsule.runId ?? `RUN-${++n}`;
      const result = await new Promise((res) => { resolvers.set(runId, res); });
      resolvers.delete(runId);
      // review capsules carry response_schema -> return a parseable PASS decision
      const structured_result = capsule.response_schema
        ? { result: JSON.stringify({ decision: 'PASS', summary: 'ok', issues: [], required_changes: [], evidence: ['e'] }) }
        : { result: '' };
      return {
        executor_run_id: runId, executor_type: type,
        assigned_role: capsule.assigned_role, status: result.status,
        session_ref: `SESS-${runId}`, structured_result,
        exit_code: 0, started_at: 's', finished_at: 'f', error: null,
      };
    },
    async resume(sessionRef, capsule) {
      const runId = capsule.runId ?? `RUN-${++n}`;
      const result = await new Promise((res) => { resolvers.set(runId, res); });
      resolvers.delete(runId);
      return {
        executor_run_id: runId, executor_type: type,
        assigned_role: capsule.assigned_role, status: result.status,
        session_ref: sessionRef, structured_result: { result: '' },
        exit_code: 0, started_at: 's', finished_at: 'f', error: null,
      };
    },
    cancel(runId) {
      cancelCalled += 1;
      cancelledRunIds.push(runId);
      resolvers.get(runId)?.({ status: 'cancelled' });
      resolvers.delete(runId);
      return { run_id: runId, already_exited: false, termination_signal: 'SIGTERM', forced: false, process_exit_observed: true };
    },
  };
}

function wsTask(id) {
  return {
    task_id: id, task_mode: 'workspace', goal: 'g', acceptance: 'a', fixture_dir: WORK,
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: [], review_rules: ['r'], requires_mcp: false,
    author_executor: 'claude', reviewer_executor: 'claude', max_revisions: 3,
  };
}

test('TEST C1: hanging executor -> cancel(runId) precisely once -> task CANCELLED', async () => {
  const fake = makeHangingFake('claude');
  const scheduler = new Scheduler({
    maxConcurrent: 2, tasksDir: WORK,
    adapters: { claude: fake, antigravity: makeHangingFake('antigravity'), codex: makeHangingFake('codex') },
  });
  const id = `TASK-C1-${++n}`;
  saveTaskAtomic(join(WORK, `${id}.json`), wsTask(id));
  scheduler.enqueue({ ...wsTask(id) });
  scheduler.runNext();
  for (let i = 0; i < 50 && !scheduler.active.has(id); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(scheduler.active.has(id), 'task must be active before cancel');
  scheduler.cancelTask(id);
  for (let i = 0; i < 100; i++) {
    const st = JSON.parse(readFileSync(join(WORK, `${id}.json`), 'utf8')).state;
    if (st === 'CANCELLED' && !scheduler.active.has(id)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const t = JSON.parse(readFileSync(join(WORK, `${id}.json`), 'utf8'));
  assert.strictEqual(t.state, 'CANCELLED');
  assert.strictEqual(fake.cancelCalled, 1, 'cancel(runId) must be called exactly once');
  assert.ok(fake.cancelledRunIds.length > 0, 'cancel must target a registered run id');
  assert.strictEqual(scheduler.active.size, 0, 'no phantom active run after cancel');
});

test('TEST C2: cancel A while B runs -> A CANCELLED, B COMPLETED (isolation)', async () => {
  const fake = makeHangingFake('claude');
  const scheduler = new Scheduler({ maxConcurrent: 2, tasksDir: WORK, adapters: { claude: fake, antigravity: makeHangingFake('antigravity'), codex: makeHangingFake('codex') } });
  const idA = `TASK-C2A-${++n}`;
  const idB = `TASK-C2B-${++n}`;
  saveTaskAtomic(join(WORK, `${idA}.json`), wsTask(idA));
  saveTaskAtomic(join(WORK, `${idB}.json`), wsTask(idB));
  scheduler.enqueue({ ...wsTask(idA) });
  scheduler.enqueue({ ...wsTask(idB) });
  scheduler.runNext();
  scheduler.runNext();
  for (let i = 0; i < 50 && (!scheduler.active.has(idA) || !scheduler.active.has(idB)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(scheduler.active.has(idA) && scheduler.active.has(idB), 'A and B must both be running before cancel');
  scheduler.cancelTask(idA);
  for (let i = 0; i < 100 && scheduler.active.has(idA); i++) await new Promise((r) => setTimeout(r, 20));
  const a = JSON.parse(readFileSync(join(WORK, `${idA}.json`), 'utf8'));
  assert.strictEqual(a.state, 'CANCELLED');
  assert.ok(scheduler.active.has(idB), 'B must still be running right after A was cancelled (isolation)');
  assert.strictEqual(fake.cancelCalled, 1, 'cancel targeted A only');
  // B keeps its own lifecycle: resolve its pending author+review runs normally
  for (let i = 0; i < 100; i++) {
    for (const rid of fake.pendingRunIds) fake.resolveRun(rid, 'completed');
    const st = JSON.parse(readFileSync(join(WORK, `${idB}.json`), 'utf8')).state;
    if (st === 'COMPLETED' && !scheduler.active.has(idB)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const b = JSON.parse(readFileSync(join(WORK, `${idB}.json`), 'utf8'));
  assert.strictEqual(b.state, 'COMPLETED');
  assert.strictEqual(fake.cancelCalled, 1, 'cancel must never have been called for B');
  assert.strictEqual(scheduler.active.size, 0, 'both chains drained');
});

test('TEST C3: cancel with no active process (already exited) still CANCELLED, no error', async () => {
  const id = `TASK-C3-${++n}`;
  const scheduler = new Scheduler({ maxConcurrent: 2, tasksDir: WORK, adapters: { claude: makeHangingFake('claude'), antigravity: makeHangingFake('antigravity'), codex: makeHangingFake('codex') } });
  saveTaskAtomic(join(WORK, `${id}.json`), wsTask(id));
  const done = scheduler.cancelTask(id);
  assert.strictEqual(done.state, 'CANCELLED');
  assert.strictEqual(done.termination?.already_exited ?? true, true);
});
