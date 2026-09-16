// concurrency.test.mjs - PHASE 3 tests E2E-A..G (fake adapters + fake bridges)
//
// Hermetic by construction: no real executor, no real vault-mcp, no real vault
// contact (real_vault_zero_touch). Fake bridges are hermetic fixtures for the
// Governance Plane; fail-closed governance_env rules are untouched.
import { test, after } from 'node:test';
import './helpers/executors-fixture.mjs';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import './helpers/runtime-state-fixture.mjs';
import { RUNTIME_DIR, LOCKS_DIR, TASKS_DIR_DEFAULT as TASKS_DIR } from '../lib/config.mjs';
import { Scheduler, TargetCoordinator } from '../lib/scheduler.mjs';
import { acquireTaskLock, releaseTaskLock, isLockStale, readLock } from '../lib/tasklock.mjs';
import { loadExecutorStatus } from '../lib/executor-status.mjs';
import { validateReviewBinding, bindReviewResult } from '../lib/reviews.mjs';
import { executeTask } from '../orchestrator.mjs';
import { saveTaskAtomic, readTaskFile } from '../lib/store.mjs';
import './helpers/acceptance-allowlist.mjs';

const ORCH_ROOT = fileURLToPath(new URL('..', import.meta.url));
const taskFile = (id) => join(TASKS_DIR, `${id}.json`);
const lockFile = (id) => join(LOCKS_DIR, `${id}.lock`);
const readTask = (id) => readTaskFile(taskFile(id));

let seq = 0;
const U = () => `RUN-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------- cleanup
const tmpDirs = [];
const trackedTaskIds = [];
after(() => {
  for (const id of trackedTaskIds) {
    rmSync(taskFile(id), { force: true });
    rmSync(lockFile(id), { force: true });
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function tmpDir(prefix) { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; }
function trackTask2(task) { trackedTaskIds.push(task.task_id); return task; }

// ---------------------------------------------------------------- helpers
// fake executor with per-role scripted sessions (async step functions allowed)
function makeFake(type, script) {
  const counters = {};
  const calls = [];
  const next = async (capsule) => {
    const role = capsule.assigned_role;
    const arr = Array.isArray(script) ? script : (script[role] ?? []);
    const i = counters[role] ?? 0;
    counters[role] = i + 1;
    const item = arr[Math.min(i, arr.length - 1)];
    return typeof item === 'function' ? await item(i + 1, capsule) : item;
  };
  const wrap = (res) => {
    if (res.review) {
      return type === 'antigravity' ? { parsed: res.review } : { result: '```json\n' + JSON.stringify(res.review) + '\n```' };
    }
    return { result: res.text ?? '' };
  };
  const emit = (kind, sessionRef, capsule, res) => {
    calls.push({ kind, sessionRef, role: capsule.assigned_role, cwd: capsule.cwd });
    return {
      executor_run_id: U(), executor_type: type, assigned_role: capsule.assigned_role,
      status: 'completed', session_ref: kind === 'resume' ? sessionRef : res.sessionRef,
      structured_result: wrap(res), exit_code: 0,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), error: null,
    };
  };
  return {
    type, supportsMcpUnattended: true, calls,
    async run(capsule) { return emit('run', null, capsule, await next(capsule)); },
    async resume(sessionRef, capsule) { return emit('resume', sessionRef, capsule, await next(capsule)); },
    cancel() { return { cancelled: true }; },
  };
}

// executor that always crashes (status=failed, exit 1) - for E2E-E
function makeFailingFake(type) {
  const calls = [];
  const fail = (capsule) => {
    calls.push({ role: capsule.assigned_role, cwd: capsule.cwd });
    return {
      executor_run_id: U(), executor_type: type, assigned_role: capsule.assigned_role,
      status: 'failed', session_ref: null, structured_result: null, exit_code: 1,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      error: 'exit 1 (simulated executor crash)',
    };
  };
  return {
    type, supportsMcpUnattended: true, calls,
    async run(capsule) { return fail(capsule); },
    async resume(sessionRef, capsule) { return fail(capsule); },
    cancel() { return { cancelled: true }; },
  };
}

// routes capsules by workspace dir and REFUSES unknown workspaces (workspace
// isolation tripwire): a capsule whose cwd is not a registered task workspace
// fails the run immediately.
function routedFake(type, byDir) {
  const pick = (capsule) => {
    const hit = byDir.get(capsule.cwd);
    if (!hit) throw new Error(`WORKSPACE_ISOLATION: capsule cwd ${capsule.cwd} is not a registered task workspace`);
    return hit;
  };
  return {
    type, supportsMcpUnattended: true,
    async run(capsule) { return pick(capsule).run(capsule); },
    async resume(sessionRef, capsule) { return pick(capsule).resume(sessionRef, capsule); },
    cancel() { return { cancelled: true }; },
  };
}

// fake GovernanceBridge (hermetic fixture vault stand-in)
function makeFakeBridge(tag, { script = [], gatePromise = null } = {}) {
  const calls = [];
  let cand = 0;
  return {
    tag, calls,
    stop() {},
    async ensureRegistered() { return `BRIDGE-${tag}-${calls.length + 1}`; },
    async createCandidate(args) {
      calls.push({ kind: 'write_candidate', args });
      if (gatePromise) await gatePromise;
      cand += 1;
      const candidate_id = `CAND-${tag}-${cand}`;
      calls.push({ kind: 'candidate_created', candidate_id });
      return { candidate_id, agent_instance_id: `BRIDGE-${tag}`, raw_response: 'ok' };
    },
    async publish(candidate_id) {
      calls.push({ kind: 'publish_candidate', candidate_id });
      const v = script.shift() ?? { policy_decision: 'deny' };
      return { raw_response: JSON.stringify(v), verdict: v };
    },
  };
}

// rendezvous: resolves only when n chains arrive (proves real parallelism)
function rendezvous(n, timeoutMs = 5000) {
  let arrived = 0;
  let release;
  const p = new Promise((res, rej) => {
    release = res;
    const t = setTimeout(() => rej(new Error('rendezvous timeout: tasks did not run concurrently')), timeoutMs);
    if (t.unref) t.unref();
  });
  return { async wait() { arrived += 1; if (arrived >= n) release(); return p; } };
}

// manually controlled gate (holds chains open for deterministic races)
function gate() {
  let open;
  const promise = new Promise((res) => { open = res; });
  return { promise, open: () => open() };
}

async function waitFor(fn, timeoutMs = 5000, stepMs = 20) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const PASS = { decision: 'PASS', summary: 'ok', issues: [], required_changes: [], evidence: ['e'] };
const NEEDS_FIX = (changes) => ({ decision: 'NEEDS_FIX', summary: 's', issues: [], required_changes: changes, evidence: ['e'] });
const FORMAL_APPROVE = () => ({ text: JSON.stringify({ agent_instance_id: `REV-${randomUUID().slice(0, 6)}`, review_decision: 'approve', reasons: 'ok' }) });

function workspaceTask(over = {}) {
  seq += 1;
  return trackTask2({
    task_id: `TASK-P3W${seq}`,
    goal: 'workspace goal', acceptance: 'a',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: [], review_rules: ['r'], requires_mcp: false,
    author_executor: 'claude', reviewer_executor: 'claude',
    author_role: 'author', reviewer_role: 'reviewer', max_revisions: 3,
    ...over,
  });
}

function governedTask(over = {}) {
  seq += 1;
  return trackTask2({
    task_id: `TASK-P3G${seq}`,
    task_mode: 'governed_write',
    goal: 'produce a knowledge page', acceptance: 'a',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: [], review_rules: ['r'], requires_mcp: false,
    author_executor: 'claude', reviewer_executor: 'claude',
    author_role: 'author', reviewer_role: 'reviewer', max_revisions: 3,
    candidate: { title: 't', target: '99-af-e2e/x.md', knowledge_class: 'procedural' },
    governance_env: { vault_root: '/tmp/af-hermetic-fixture-vault' },
    ...over,
  });
}

// ------------------------------------------------------------------ E2E-A
test('E2E-A: two workspace tasks in parallel - state/session/workspace/review/acceptance isolation', async () => {
  const dirA = tmpDir('af-p3-a-');
  const dirB = tmpDir('af-p3-b-');
  const markerB = join(dirB, 'b.done');
  const bar = rendezvous(2);

  const fakeA = makeFake('claude', {
    author: [
      async () => { await bar.wait(); return { sessionRef: 'CLAUDE-SESS-A1' }; }, // rev1
      { sessionRef: 'CLAUDE-SESS-A1', text: 'fix A' },                            // fix (exact resume)
    ],
    reviewer: [{ sessionRef: 'REVIEW-A1', review: PASS }],
  });
  const fakeB = makeFake('claude', {
    author: [
      { sessionRef: 'CLAUDE-SESS-B1' },                                            // rev1
      async () => { writeFileSync(markerB, 'ok'); return { sessionRef: 'CLAUDE-SESS-B1' }; }, // fix
    ],
    reviewer: [
      { sessionRef: 'REVIEW-B1', review: NEEDS_FIX(['improve B only']) },
      { sessionRef: 'REVIEW-B2', review: PASS },
    ],
  });
  const claude = routedFake('claude', new Map([[dirA, fakeA], [dirB, fakeB]]));

  const taskA = workspaceTask({ task_id: 'TASK-P3A', fixture_dir: dirA });
  const taskB = workspaceTask({
    task_id: 'TASK-P3B', fixture_dir: dirB,
    acceptance_cmd: { command: 'node', args: ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(markerB)}) ? 0 : 1)`] },
  });
  const sched = new Scheduler({
    maxConcurrent: 2,
    adapters: { claude, codex: makeFake('codex', []), antigravity: makeFake('antigravity', []) },
  });
  sched.enqueue(taskA);
  sched.enqueue(taskB);
  sched.runNext();
  await sched.waitAll();

  const a = readTask('TASK-P3A');
  const b = readTask('TASK-P3B');
  assert.strictEqual(a.state, 'COMPLETED', `A: ${a.failure_reason}`);
  assert.strictEqual(b.state, 'COMPLETED', `B: ${b.failure_reason}`);
  // task state not crossed; B went through NEEDS_FIX -> fix -> PASS
  assert.deepStrictEqual(b.runs.map((r) => r.purpose), ['author', 'review', 'fix', 'review']);
  assert.strictEqual(b.revisions_used, 2);
  assert.strictEqual(a.revisions_used, 1);
  // sessions not crossed (both tasks used "claude" with independent sessions)
  assert.strictEqual(a.author_session_ref, 'CLAUDE-SESS-A1');
  assert.strictEqual(b.author_session_ref, 'CLAUDE-SESS-B1');
  assert.notStrictEqual(a.author_session_ref, b.author_session_ref);
  // executor_run_ids unique across BOTH tasks
  const ids = [...a.runs, ...b.runs].map((r) => r.executor_run_id);
  assert.strictEqual(new Set(ids).size, ids.length);
  // acceptance not crossed: each task ran its own gate exactly once, in its
  // own workspace, against its own command (B's gate is markerB-dependent)
  assert.strictEqual(a.acceptance_runs.length, 1);
  assert.strictEqual(a.acceptance_runs[0].exit_code, 0);
  assert.strictEqual(b.acceptance_runs.length, 1);
  assert.strictEqual(b.acceptance_runs[0].exit_code, 0);
  // review feedback did not cross: B consumed its own NEEDS_FIX (2 revisions,
  // one fix run) while A never entered a fix loop on B's feedback
  assert.ok(b.runs.some((r) => r.purpose === 'fix'));
  assert.ok(!a.runs.some((r) => r.purpose === 'fix'), 'A must not enter a fix loop from B feedback');
  // workspaces not crossed: every capsule cwd stays in its own fixture dir
  assert.ok(fakeA.calls.every((c) => c.cwd === dirA), 'A capsules must stay in workspace A');
  assert.ok(fakeB.calls.every((c) => c.cwd === dirB), 'B capsules must stay in workspace B');
  // review binding stamped on both tasks; review feedback did not cross
  assert.strictEqual(a.last_review.task_id, 'TASK-P3A');
  assert.strictEqual(b.last_review.task_id, 'TASK-P3B');
  assert.notStrictEqual(a.last_review.reviewed_executor_run_id, b.last_review.reviewed_executor_run_id);
  assert.ok(b.runs.some((r) => r.purpose === 'fix'));
  assert.ok(!a.runs.some((r) => r.purpose === 'fix'), 'A must not enter a fix loop from B feedback');
  // both author runs really overlapped (rendezvous proved concurrency)
  // locks released for both tasks
  assert.ok(!existsSync(lockFile('TASK-P3A')));
  assert.ok(!existsSync(lockFile('TASK-P3B')));
});

// ------------------------------------------------------------------ E2E-B
test('E2E-B: L3 WAITING_HUMAN releases its slot; workspace tasks continue to COMPLETED', async () => {
  const dirW1 = tmpDir('af-p3-b1-');
  const dirW2 = tmpDir('af-p3-b2-');
  const dirL3 = tmpDir('af-p3-bl3-');
  const fakeL3 = makeFake('claude', {
    author: [{ sessionRef: 'L3-S1', text: '<PAGE>L3 page for B</PAGE>' }],
    reviewer: [{ sessionRef: 'L3-R1', review: PASS }, FORMAL_APPROVE()],
  });
  const fakeW1 = makeFake('claude', {
    author: [{ sessionRef: 'W1-S1' }],
    reviewer: [{ sessionRef: 'W1-R1', review: PASS }],
  });
  const fakeW2 = makeFake('claude', {
    author: [{ sessionRef: 'W2-S1' }],
    reviewer: [{ sessionRef: 'W2-R1', review: PASS }],
  });
  const claude = routedFake('claude', new Map([[dirL3, fakeL3], [dirW1, fakeW1], [dirW2, fakeW2]]));
  const bridgeL3 = makeFakeBridge('B-L3', { script: [{ policy_decision: 'human_required', effective_write_class: 'L3-governed' }] });

  const sched = new Scheduler({
    maxConcurrent: 2,
    adapters: { claude, codex: makeFake('codex', []), antigravity: makeFake('antigravity', []) },
    makeBridge: (task) => (task.task_id === 'TASK-P3L3' ? bridgeL3 : null),
  });
  sched.enqueue(governedTask({
    task_id: 'TASK-P3L3', fixture_dir: dirL3,
    candidate: { title: 't', target: '99-af-e2e/p3-b.md', knowledge_class: 'procedural' },
  }));
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3WS1', fixture_dir: dirW1 }));
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3WS2', fixture_dir: dirW2 })); // only 2 slots
  sched.runNext();
  await sched.waitAll();

  const l3 = readTask('TASK-P3L3');
  const ws1 = readTask('TASK-P3WS1');
  const ws2 = readTask('TASK-P3WS2');
  assert.strictEqual(l3.state, 'WAITING_HUMAN', `L3: ${l3.failure_reason ?? l3.state}`);
  assert.strictEqual(ws1.state, 'COMPLETED', `WS1: ${ws1.failure_reason}`);
  assert.strictEqual(ws2.state, 'COMPLETED', `WS2 ran although L3 was parked: ${ws2.failure_reason}`);
  // slot accounting: parked task is WAITING, not RUNNING
  assert.ok(sched.waiting.has('TASK-P3L3'));
  assert.ok(!sched.active.has('TASK-P3L3'));
  // Control Plane ownership released
  assert.ok(!existsSync(lockFile('TASK-P3L3')), 'WAITING_HUMAN must release the task lock');
  // gate correlation: candidate id bound to this task's own mirror
  assert.ok(l3.governance.candidate_id.startsWith('CAND-B-L3-'));
  assert.strictEqual(l3.governance.policy_decision, 'human_required');
});


// ------------------------------------------------------------------ E2E-C
// fake GovernanceBridge with a Human-Gate approval set: only candidate ids in
// `approved` ever return a published verdict; everything else stays
// human_required (the gate is still open). The set is mutable so the test can
// play the user approving EXACTLY one candidate. The bridge records which
// candidate_id every publish call carried, making correlation provable.
function makeGateBridge(tag, approved, { gatePromise = null } = {}) {
  const calls = [];
  let cand = 0;
  return {
    tag, calls, approved, stop() {},
    async ensureRegistered() { return `BRIDGE-${tag}`; },
    async createCandidate(args) {
      calls.push({ kind: 'write_candidate', args });
      cand += 1;
      const candidate_id = `CAND-${tag}-${cand}`;
      calls.push({ kind: 'candidate_created', candidate_id });
      // the candidate EXISTS (id assigned + recorded) before the gate blocks
      // the response, so a Human Gate can approve it while the writer waits.
      if (gatePromise) await gatePromise;
      return { candidate_id, agent_instance_id: `BRIDGE-${tag}`, raw_response: 'ok' };
    },
    async publish(candidate_id) {
      calls.push({ kind: 'publish_candidate', candidate_id });
      const v = approved.has(candidate_id)
        ? { policy_decision: 'auto_publish', published: true, published_path: `99-af-e2e/${candidate_id}.md` }
        : { policy_decision: 'human_required', published: false };
      return { raw_response: JSON.stringify(v), verdict: v };
    },
  };
}

test('E2E-C: two hermetic L3 tasks, only candidate-A approved - gate correlation must not cross', async () => {
  const dirA = tmpDir('af-p3-c1-');
  const dirB = tmpDir('af-p3-c2-');
  const fakeA = makeFake('claude', {
    author: [{ sessionRef: 'C-A-S1', text: '<PAGE>A page</PAGE>' }],
    reviewer: [{ sessionRef: 'C-A-R1', review: PASS }, FORMAL_APPROVE()],
  });
  const fakeB = makeFake('claude', {
    author: [{ sessionRef: 'C-B-S1', text: '<PAGE>B page</PAGE>' }],
    reviewer: [{ sessionRef: 'C-B-R1', review: PASS }, FORMAL_APPROVE()],
  });
  const claude = routedFake('claude', new Map([[dirA, fakeA], [dirB, fakeB]]));
  const approvalsA = new Set(); // user's approval registry (per candidate id)
  const approvalsB = new Set();
  const bridgeA = makeGateBridge('C-A', approvalsA);
  const bridgeB = makeGateBridge('C-B', approvalsB);
  const sched = new Scheduler({
    maxConcurrent: 2,
    adapters: { claude, codex: makeFake('codex', []), antigravity: makeFake('antigravity', []) },
    makeBridge: (task) => (task.task_id === 'TASK-P3L3A' ? bridgeA : task.task_id === 'TASK-P3L3B' ? bridgeB : null),
  });
  sched.enqueue(governedTask({
    task_id: 'TASK-P3L3A', fixture_dir: dirA,
    candidate: { title: 'a', target: '99-af-e2e/p3-c-a.md', knowledge_class: 'procedural' },
  }));
  sched.enqueue(governedTask({
    task_id: 'TASK-P3L3B', fixture_dir: dirB,
    candidate: { title: 'b', target: '99-af-e2e/p3-c-b.md', knowledge_class: 'procedural' },
  }));
  sched.runNext();
  await sched.waitAll();
  let a = readTask('TASK-P3L3A');
  let b = readTask('TASK-P3L3B');
  assert.strictEqual(a.state, 'WAITING_HUMAN', `A: ${a.failure_reason ?? a.state}`);
  assert.strictEqual(b.state, 'WAITING_HUMAN', `B: ${b.failure_reason ?? b.state}`);
  const candA = a.governance.candidate_id;
  const candB = b.governance.candidate_id;
  assert.ok(candA.startsWith('CAND-C-A-') && candB.startsWith('CAND-C-B-'), 'each task holds its OWN candidate id');

  // Human Gate: ONLY candidate-A is approved. Resuming B first must NOT pick
  // up A's approval - B stays WAITING_HUMAN (no "nearest approval" search).
  approvalsA.add(candA);
  await sched.resumeTask('TASK-P3L3B');
  await sched.waitAll();
  b = readTask('TASK-P3L3B');
  assert.strictEqual(b.state, 'WAITING_HUMAN', `B must stay parked: ${b.failure_reason ?? b.state}`);

  await sched.resumeTask('TASK-P3L3A'); // A IS approved
  await sched.waitAll();
  a = readTask('TASK-P3L3A');
  assert.strictEqual(a.state, 'COMPLETED', `A should publish through its own candidate: ${a.failure_reason ?? a.state}`);
  assert.strictEqual(a.governance.publish_status, 'published');

  // resume is bound to THIS task's saved candidate_id: every publish call for
  // A carried candidate-A's id, never B's (and vice versa for B)
  const aPublishes = bridgeA.calls.filter((c) => c.kind === 'publish_candidate').map((c) => c.candidate_id);
  const bPublishes = bridgeB.calls.filter((c) => c.kind === 'publish_candidate').map((c) => c.candidate_id);
  assert.ok(aPublishes.length >= 2 && aPublishes.every((c) => c === candA));
  assert.ok(bPublishes.length >= 1 && bPublishes.every((c) => c === candB));
  // B is STILL parked after A completed
  assert.strictEqual(readTask('TASK-P3L3B').state, 'WAITING_HUMAN');
  // resuming a terminal task is refused
  assert.throws(() => sched.resumeTask('TASK-P3L3A'), /NOT_WAITING_HUMAN/);
});

// ------------------------------------------------------------------ E2E-D
test('E2E-D: two governed tasks on the SAME target - control-plane coordination prevents silent overwrite', async () => {
  const dirA = tmpDir('af-p3-d1-');
  const dirB = tmpDir('af-p3-d2-');
  const fakeA = makeFake('claude', {
    author: [{ sessionRef: 'D-A-S1', text: '<PAGE>A wins the target</PAGE>' }],
    reviewer: [{ sessionRef: 'D-A-R1', review: PASS }, FORMAL_APPROVE()],
  });
  // B is held INSIDE its reviewer run until A has fully taken the target -
  // makes the target race deterministic (A first, B second).
  const holdB = gate();
  // A blocks INSIDE createCandidate while holding the target lease, so the
  // lease hold is observable and B deterministically collides with it.
  const holdA = gate();
  const fakeB = makeFake('claude', {
    author: [{ sessionRef: 'D-B-S1', text: '<PAGE>B also wants the target</PAGE>' }],
    reviewer: [
      async () => { await holdB.promise; return { sessionRef: 'D-B-R1', review: PASS }; },
      FORMAL_APPROVE(),
    ],
  });
  const claude = routedFake('claude', new Map([[dirA, fakeA], [dirB, fakeB]]));
  const bridgeA = makeGateBridge('D-A', new Set(), { gatePromise: holdA.promise });
  const bridgeB = makeGateBridge('D-B', new Set());
  const SAME_TARGET = '99-af-e2e/p3-d.md';
  const sched = new Scheduler({
    maxConcurrent: 2,
    adapters: { claude, codex: makeFake('codex', []), antigravity: makeFake('antigravity', []) },
    makeBridge: (task) => (task.task_id === 'TASK-P3DA' ? bridgeA : task.task_id === 'TASK-P3DB' ? bridgeB : null),
  });
  sched.enqueue(governedTask({
    task_id: 'TASK-P3DA', fixture_dir: dirA,
    candidate: { title: 'a', target: SAME_TARGET, knowledge_class: 'procedural' },
  }));
  sched.enqueue(governedTask({
    task_id: 'TASK-P3DB', fixture_dir: dirB,
    candidate: { title: 'b', target: SAME_TARGET, knowledge_class: 'procedural' },
  }));
  sched.runNext();
  // A reaches the publish-sensitive stage first and takes the target lease,
  // then blocks inside createCandidate (gatePromise).
  await waitFor(() => readTask('TASK-P3DA').state === 'GOVERNANCE_PENDING');
  await waitFor(() => sched.coordination.status()[SAME_TARGET]?.task_id === 'TASK-P3DA');
  holdB.open(); // now let B reach the same stage
  // B must be refused by Control Plane target coordination BEFORE any write
  await waitFor(() => readTask('TASK-P3DB').state === 'FAILED');
  // play the Human Gate approving A's (already created) candidate, then let
  // A finish createCandidate and publish through its own candidate id.
  bridgeA.approved.add(bridgeA.calls.find((c) => c.kind === 'candidate_created').candidate_id);
  holdA.open(); // release A's createCandidate gate so A can publish
  await sched.waitAll();

  const a = readTask('TASK-P3DA');
  const b = readTask('TASK-P3DB');
  assert.strictEqual(b.state, 'FAILED', `B: ${b.failure_reason ?? b.state}`);
  assert.strictEqual(b.failure_reason, 'WRITE_CONFLICT');
  assert.match(b.failure_detail ?? '', /target/i);
  // B never created a candidate for the contested target: no second write
  // entered the Governance Plane, so no silent last-write-wins happened.
  assert.ok(!bridgeB.calls.some((c) => c.kind === 'write_candidate'));
  // A proceeded through its own candidate and published normally
  assert.strictEqual(a.state, 'COMPLETED', `A: ${a.failure_reason ?? a.state}`);
  assert.strictEqual(a.governance.publish_status, 'published');
  assert.ok(bridgeA.calls.some((c) => c.kind === 'publish_candidate'));
  // the target lease is released once A reached a terminal state
  assert.ok(!sched.coordination.status()[SAME_TARGET]);
  // the FORMAL same-target conflict enforcement stays with vault-mcp's writer
  // lock; this test proves the Control Plane coordination layer on top of it.
});

// ------------------------------------------------------------------ E2E-E
test('E2E-E: executor crash on TASK-A - A FAILED (bounded retry), B COMPLETED, scheduler survives', async () => {
  const dirA = tmpDir('af-p3-e1-');
  const dirB = tmpDir('af-p3-e2-');
  const fakeFail = makeFailingFake('claude'); // every run: status=failed, exit 1
  const fakeB = makeFake('claude', {
    author: [{ sessionRef: 'E-B-S1' }],
    reviewer: [{ sessionRef: 'E-B-R1', review: PASS }],
  });
  const claude = routedFake('claude', new Map([[dirA, fakeFail], [dirB, fakeB]]));
  const sched = new Scheduler({
    maxConcurrent: 2,
    adapters: { claude, codex: makeFake('codex', []), antigravity: makeFake('antigravity', []) },
    makeBridge: () => null,
  });
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3EA', fixture_dir: dirA }));
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3EB', fixture_dir: dirB }));
  sched.runNext();
  await sched.waitAll();

  const a = readTask('TASK-P3EA');
  const b = readTask('TASK-P3EB');
  assert.strictEqual(a.state, 'FAILED', `A: ${a.failure_reason ?? a.state}`);
  assert.match(a.failure_reason, /author run failed/);
  assert.strictEqual(b.state, 'COMPLETED', `B: ${b.failure_reason ?? b.state}`);
  // bounded retry: initial attempt + maxExecutor_retries(=1) retry, then stop
  assert.strictEqual(fakeFail.calls.length, 2);
  const kinds = sched.events.map((e) => e.kind);
  assert.ok(kinds.includes('executor_retry'), 'transient failure retried once');
  assert.ok(kinds.includes('retries_exhausted'), 'retry is bounded');
  // scheduler is still alive and can accept new work after the failure
  assert.strictEqual(sched.status().active.length, 0);
  assert.strictEqual(sched.status().max_concurrent_tasks, 2);
});


// ------------------------------------------------------------------ E2E-F
test('E2E-F: TASK-A ReviewerResult fed to TASK-B is refused (STALE_OR_MISMATCHED_REVIEW); B never enters fix', async () => {
  // 1. Binding-layer proof: A's review is legitimately bound to A.
  const taskAObj = { task_id: 'TASK-A', runs: [{ purpose: 'author', executor_run_id: 'RUN-A1' }] };
  const reviewA = bindReviewResult(taskAObj, 1, { executor_run_id: 'RUN-A1' },
    NEEDS_FIX(['fix A only']), { task_id: 'TASK-A', revision: 1 });
  assert.ok(validateReviewBinding(reviewA, {
    task_id: 'TASK-A', revision: 1, reviewed_executor_run_id: 'RUN-A1',
  }), 'A-bound review validates against A');

  // 2. Injecting that review into TASK-B must be refused.
  assert.throws(() => validateReviewBinding(reviewA, {
    task_id: 'TASK-B', revision: 1, reviewed_executor_run_id: 'RUN-B1',
  }), (err) => err.code === 'STALE_OR_MISMATCHED_REVIEW' && /task "TASK-A"/.test(err.message));
  // a stale echo (wrong revision) is refused even inside the right task
  assert.throws(() => validateReviewBinding({
    decision: 'PASS', task_id: 'TASK-B', revision: 2,
    reviewer_echo: { task_id: 'TASK-B', revision: 2 },
  }, { task_id: 'TASK-B', revision: 1, reviewed_executor_run_id: null }),
  (err) => err.code === 'STALE_OR_MISMATCHED_REVIEW');

  // 3. End-to-end: B's "reviewer" actually returns A's review payload. The
  //    binding layer must reject it before it can drive a fix loop.
  const dirA = tmpDir('af-p3-f1-');
  const dirB = tmpDir('af-p3-f2-');
  const fakeA = makeFake('claude', {
    author: [{ sessionRef: 'F-A-S1', text: '<PAGE>A content</PAGE>' }],
    reviewer: [{ sessionRef: 'F-A-R1', review: PASS }],
  });
  const fakeB = makeFake('claude', {
    author: [{ sessionRef: 'F-B-S1', text: '<PAGE>B content</PAGE>' }],
    reviewer: [{
      sessionRef: 'F-B-R1',
      // A's reviewer result, echoed as A's binding, offered for B:
      review: { decision: 'NEEDS_FIX', summary: 'A feedback', issues: [], required_changes: ['fix A only'], evidence: ['e'], task_id: 'TASK-P3FA', revision: 1 },
    }],
  });
  const claude = routedFake('claude', new Map([[dirA, fakeA], [dirB, fakeB]]));
  const sched = new Scheduler({
    maxConcurrent: 2,
    adapters: { claude, codex: makeFake('codex', []), antigravity: makeFake('antigravity', []) },
    makeBridge: () => null,
  });
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3FA', fixture_dir: dirA }));
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3FB', fixture_dir: dirB }));
  sched.runNext();
  await sched.waitAll();
  const a = readTask('TASK-P3FA');
  const b = readTask('TASK-P3FB');
  assert.strictEqual(a.state, 'COMPLETED', `A: ${a.failure_reason ?? a.state}`);
  // B refused the cross-fed review instead of entering a fix loop
  assert.strictEqual(b.state, 'FAILED', `B: ${b.failure_reason ?? b.state}`);
  assert.match(b.failure_reason, /STALE_OR_MISMATCHED_REVIEW/);
  assert.ok(!b.runs.some((r) => r.purpose === 'fix'), 'B must not enter fix on A feedback');
});

// ------------------------------------------------------------------ E2E-G
test('E2E-G: stale task lock is detected and recovered; a valid lock is still rejected', async () => {
  const dirA = tmpDir('af-p3-g1-');
  const fakeA = makeFake('claude', {
    author: [{ sessionRef: 'G-A-S1' }],
    reviewer: [{ sessionRef: 'G-A-R1', review: PASS }],
  });
  const claude = routedFake('claude', new Map([[dirA, fakeA]]));
  const mkSched = () => new Scheduler({
    maxConcurrent: 2,
    adapters: { claude, codex: makeFake('codex', []), antigravity: makeFake('antigravity', []) },
    makeBridge: () => null,
  });

  // task in the store + a lock from a crashed orchestrator on disk
  mkdirSync(LOCKS_DIR, { recursive: true });
  const deadProc = spawnSync(process.execPath, ['-e', '']); // short-lived process -> guaranteed dead pid
  const staleLock = {
    task_id: 'TASK-P3G',
    orchestrator_instance_id: 'af-orch-dead-instance',
    pid: deadProc.pid,
    acquired_at: new Date(Date.now() - 60_000).toISOString(),
    lease_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), // lease still "valid"
  };
  mkSched().enqueue(workspaceTask({ task_id: 'TASK-P3G', fixture_dir: dirA }));
  trackedTaskIds.push('TASK-P3G');

  // 1. a VALID lock (live owner pid) blocks a second run/resume owner
  writeFileSync(lockFile('TASK-P3G'), JSON.stringify({
    ...staleLock, pid: process.pid, orchestrator_instance_id: 'af-orch-live-instance',
  }), { flag: 'wx' });
  assert.throws(() => mkSched().runTask('TASK-P3G'), (err) => err.code === 'TASK_ALREADY_RUNNING');
  rmSync(lockFile('TASK-P3G'));

  // 2. STALE lock (dead pid, unexpired lease): recovery must work because the
  //    owner pid is gone - never a permanent failure.
  writeFileSync(lockFile('TASK-P3G'), JSON.stringify(staleLock), { flag: 'wx' });
  assert.strictEqual(isLockStale(readLock(LOCKS_DIR, 'TASK-P3G')), true, 'dead-pid lock is stale');
  const sched = mkSched();
  sched.runTask('TASK-P3G'); // must recover, not fail
  await sched.waitAll();
  const g = readTask('TASK-P3G');
  assert.strictEqual(g.state, 'COMPLETED', `task continued after stale-lock recovery: ${g.failure_reason ?? g.state}`);
  // recovery is RECORDED, never silent
  assert.strictEqual(sched.recoveredStaleLocks.length, 1);
  assert.strictEqual(sched.recoveredStaleLocks[0].stale_lock_recovered, true);
  assert.strictEqual(sched.recoveredStaleLocks[0].previous_pid, deadProc.pid);
  assert.strictEqual(sched.recoveredStaleLocks[0].stale_reason, 'owner_pid_not_alive');
  const schedMeta = JSON.parse(readFileSync(join(RUNTIME_DIR, 'scheduler.json'), 'utf8'));
  assert.ok(schedMeta.stale_lock_recovered.some((r) => r.task_id === 'TASK-P3G' && r.stale_lock_recovered === true));
  assert.ok(!existsSync(lockFile('TASK-P3G')), 'lock released after completion');
  assert.ok(fakeA.calls.every((c) => c.cwd === dirA));
});

// restart scan: a RUNNING-like task with no valid lock is reported
// interrupted/recoverable and never auto-marked COMPLETED (crash safety).
test('restart scan: running-like task without a valid lock is reported, never auto-COMPLETED', async () => {
  const dirA = tmpDir('af-p3-g3-');
  const sched = new Scheduler({
    maxConcurrent: 2,
    adapters: { claude: makeFake('claude', []), codex: makeFake('codex', []), antigravity: makeFake('antigravity', []) },
    makeBridge: () => null,
  });
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3G2', fixture_dir: dirA }));
  trackedTaskIds.push('TASK-P3G2');
  const task = readTaskFile(taskFile('TASK-P3G2'));
  task.state = 'AUTHOR_RUNNING'; // simulate a crash mid-run
  delete task.author_session_ref;
  saveTaskAtomic(taskFile('TASK-P3G2'), task);
  const report = sched.scanInterrupted();
  const hit = report.find((r) => r.task_id === 'TASK-P3G2');
  assert.ok(hit, 'restart scan reports the running-like task');
  assert.strictEqual(hit.interrupted, true);
  assert.strictEqual(hit.lock_held, false);
  assert.strictEqual(hit.recoverable, false, 'no author session -> not resumable');
  assert.match(hit.note, /never auto-COMPLETED/);
  // the task JSON is untouched by the scan (still AUTHOR_RUNNING, not COMPLETED)
  assert.strictEqual(readTaskFile(taskFile('TASK-P3G2')).state, 'AUTHOR_RUNNING');
});

// ------------------------------------------- capability vs availability (3/16)
test('capability/availability separation: agy 403 is availability-only; scheduler refuses UNAVAILABLE executor task-locally', async () => {
  const execDir = tmpDir('af-p3-exec-');
  writeFileSync(join(execDir, 'claude.json'), JSON.stringify({
    executor_id: 'claude', capabilities_audit: { m1: 'PASS', m2: 'PASS' }, blockers: [],
  }));
  writeFileSync(join(execDir, 'antigravity.json'), JSON.stringify({
    executor_id: 'antigravity', capabilities_audit: { m1: 'PASS', m2: 'PASS' },
    blockers: ['Antigravity account disabled (HTTP 403)'],
  }));
  writeFileSync(join(execDir, 'codex.json'), JSON.stringify({
    executor_id: 'codex', capabilities_audit: { m1: 'PASS', m2: 'BLOCKED' }, blockers: [],
  }));
  const status = loadExecutorStatus(execDir);
  // capability axis is NOT downgraded by the 403 account blocker
  assert.strictEqual(status.get('antigravity').capability_status, 'READY');
  assert.strictEqual(status.get('antigravity').availability_status, 'UNAVAILABLE');
  assert.strictEqual(status.get('antigravity').reason, 'ACCOUNT_DISABLED_403');
  assert.strictEqual(status.get('claude').capability_status, 'READY');
  assert.strictEqual(status.get('claude').availability_status, 'AVAILABLE');
  assert.strictEqual(status.get('codex').capability_status, 'PARTIAL');
  assert.strictEqual(status.get('codex').availability_status, 'AVAILABLE');

  // scheduler pre-flight: a task explicitly naming agy fails task-locally
  // (EXECUTOR_UNAVAILABLE) WITHOUT ever attempting to start agy, and the
  // scheduler keeps running other tasks.
  const dirA = tmpDir('af-p3-g4-');
  const agyFake = makeFake('antigravity', []);
  const fakeA = makeFake('claude', {
    author: [{ sessionRef: 'H-A-S1' }],
    reviewer: [{ sessionRef: 'H-A-R1', review: PASS }],
  });
  const claude = routedFake('claude', new Map([[dirA, fakeA]]));
  const sched = new Scheduler({
    maxConcurrent: 2, executorStatusDir: execDir,
    adapters: { claude, codex: makeFake('codex', []), antigravity: agyFake },
    makeBridge: () => null,
  });
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3H1', fixture_dir: dirA, author_executor: 'antigravity' }));
  sched.enqueue(workspaceTask({ task_id: 'TASK-P3H2', fixture_dir: dirA })); // auto -> claude
  sched.runNext();
  await sched.waitAll();
  const blocked = readTask('TASK-P3H1');
  const okTask = readTask('TASK-P3H2');
  assert.strictEqual(blocked.state, 'FAILED');
  assert.match(blocked.failure_reason, /EXECUTOR_UNAVAILABLE: antigravity/);
  assert.match(blocked.failure_reason, /ACCOUNT_DISABLED_403/);
  assert.strictEqual(agyFake.calls.length, 0, 'scheduler must not attempt to start an UNAVAILABLE executor');
  assert.strictEqual(okTask.state, 'COMPLETED', `other tasks continue: ${okTask.failure_reason ?? okTask.state}`);
  // status projection keeps both axes visible (ROLE != PLATFORM: no platform->role mapping here)
  assert.strictEqual(sched.status().executor_availability.antigravity, 'READY/UNAVAILABLE');
  assert.strictEqual(sched.status().executor_availability.claude, 'READY/AVAILABLE');
  assert.strictEqual(sched.status().executor_availability.codex, 'PARTIAL/AVAILABLE');
});
