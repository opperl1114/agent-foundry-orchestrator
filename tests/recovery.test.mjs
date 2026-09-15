// recovery.test.mjs - PHASE 4 crash/recovery tests A-J (fake adapters/bridges)
// State-injection style: each test writes a task JSON into an isolated
// tasks dir at a specific crash point, then drives recoverTask/continueTask.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before } from 'node:test';
import { recoverTask } from '../lib/recovery.mjs';
import { continueTask, resumeGovernance } from '../orchestrator.mjs';
import { saveTaskAtomic } from '../lib/store.mjs';
import { acquireTaskLock, readLock } from '../lib/tasklock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let WORK;   // isolated tasks dir (per-test root)
let FIXDIR; // existing fixture workspace dir (cwd for claude spawns)
let seq = 0;
const UUID = () => `RUN-${(++seq).toString(16)}`;

before(() => {
  WORK = mkdtempSync(join(tmpdir(), 'af-p4-work-'));
  FIXDIR = mkdtempSync(join(tmpdir(), 'af-p4-fix-'));
});
after(() => { rmSync(WORK, { recursive: true, force: true }); rmSync(FIXDIR, { recursive: true, force: true }); });

function makeFake(type, script = []) {
  const counters = {};
  const calls = [];
  const next = (capsule) => {
    const role = capsule.assigned_role;
    const arr = Array.isArray(script) ? script : (script[role] ?? []);
    const i = counters[role] ?? 0;
    counters[role] = i + 1;
    const item = arr[Math.min(i, arr.length - 1)];
    return typeof item === 'function' ? item(i + 1, capsule) : item;
  };
  const wrap = (res) => {
    if (res.review) return type === 'antigravity' ? { parsed: res.review } : { result: '```json\n' + JSON.stringify(res.review) + '\n```' };
    return { result: res.text ?? '' };
  };
  return {
    type, supportsMcpUnattended: true, calls,
    async run(capsule) {
      const res = next(capsule);
      calls.push({ kind: 'run', role: capsule.assigned_role });
      return {
        executor_run_id: UUID(), executor_type: type, assigned_role: capsule.assigned_role,
        status: 'completed', session_ref: res.sessionRef, structured_result: wrap(res),
        exit_code: 0, started_at: 's', finished_at: 'f', error: null,
      };
    },
    async resume(sessionRef, capsule) {
      const res = next(capsule);
      calls.push({ kind: 'resume', sessionRef, role: capsule.assigned_role });
      return {
        executor_run_id: UUID(), executor_type: type, assigned_role: capsule.assigned_role,
        status: 'completed', session_ref: sessionRef, structured_result: wrap(res),
        exit_code: 0, started_at: 's', finished_at: 'f', error: null,
      };
    },
    cancel() { return { cancelled: true }; },
  };
}

const PASS = { decision: 'PASS', summary: 'ok', issues: [], required_changes: [], evidence: ['e'] };
const NEEDS_FIX = { decision: 'NEEDS_FIX', summary: 's', issues: [], required_changes: ['add JSDoc'], evidence: ['e'] };

// fake GovernanceBridge: scripted verdicts + a read-only client for settle
function makeFakeBridge(script = [], opts = {}) {
  const calls = [];
  return {
    calls, requested_instance_id: null,
    client: {
      async call(name) {
        calls.push({ kind: name });
        if (name === 'vault_read') return { raw: opts.publishedContent ?? '# page\n', json: null };
        return { raw: '{}', json: {} };
      },
    },
    stop() {},
    async ensureRegistered() { return 'BRIDGE-INST-1'; },
    async createCandidate(args) {
      calls.push({ kind: 'write_candidate', args });
      return { candidate_id: `CAND-${calls.length}`, agent_instance_id: 'BRIDGE-INST-1', raw_response: 'ok' };
    },
    async publish(candidate_id) {
      calls.push({ kind: 'publish_candidate', candidate_id });
      const v = script.shift() ?? { policy_decision: 'human_required' };
      return { raw_response: JSON.stringify(v), verdict: v };
    },
  };
}

// Build a task JSON at a specific crash point.
function baseTask(id, state, over = {}) {
  return {
    task_id: id,
    task_mode: 'workspace',
    goal: 'g', acceptance: 'a', fixture_dir: FIXDIR,
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: [], review_rules: ['r1'],
    requires_mcp: false,
    author_executor: 'claude', reviewer_executor: 'claude',
    author_role: 'author', reviewer_role: 'reviewer',
    max_revisions: 3, timeout_ms: 60000,
    state, state_version: 5,
    runs: [], revisions_used: 1,
    ...over,
  };
}
const authorRun = (id, sess) => ({
  executor_run_id: id, executor_type: 'claude', assigned_role: 'author', purpose: 'author',
  status: 'completed', session_ref: sess, exit_code: 0, started_at: 's', finished_at: 'f', error: null,
});
const reviewRun = (id, sess) => ({
  executor_run_id: id, executor_type: 'claude', assigned_role: 'reviewer', purpose: 'review',
  status: 'completed', session_ref: sess, exit_code: 0, started_at: 's', finished_at: 'f', error: null,
});
const fixRun = (id, sess) => ({
  executor_run_id: id, executor_type: 'claude', assigned_role: 'author', purpose: 'fix',
  status: 'completed', session_ref: sess, exit_code: 0, started_at: 's', finished_at: 'f', error: null,
});

function writeTaskFile(task) {
  saveTaskAtomic(join(WORK, `${task.task_id}.json`), task);
}

// recoverTask wired to the REAL continueTask (product code) with injected
// fakes; availability defaults to the canonical projection (claude AVAILABLE).
// fakes; availability defaults to the canonical projection (claude AVAILABLE).
// `adapters` must contain the fakes that will actually execute runs.
async function recover(taskId, { bridge = null, availability = null, planStateVersion = null, adapters = null } = {}) {
  return recoverTask(taskId, {
    tasksDir: WORK, locksDir: WORK,
    continueTaskFn: (id, o = {}) => continueTask(id, adapters ?? realAdapters(), { ...o, tasksDir: WORK }),
    resumeGovernanceFn: (id, o = {}) => resumeGovernance(id, { ...o, tasksDir: WORK }),
    adapters: adapters ?? realAdapters(),
    governanceBridge: bridge,
    availability,
    orchestratorInstanceId: `orch-${(++seq).toString(36)}`,
    planStateVersion,
  });
}
function realAdapters() {
  return { antigravity: { type: 'antigravity', supportsMcpUnattended: true }, claude: { type: 'claude', supportsMcpUnattended: true }, codex: { type: 'codex', supportsMcpUnattended: false } };
}

before(() => {});
after(() => {});

let n = 0;

test('TEST A: author persisted, review never ran -> recover runs ONLY the reviewer -> COMPLETED', async () => {
  const reviewer = makeFake('claude', [{ sessionRef: 'REV-A', review: PASS }]);
  const bridge = makeFakeBridge([]);
  const id = `TASK-P4A-${++n}`;
  writeTaskFile(baseTask(id, 'AUTHOR_RUNNING', {
    runs: [authorRun('RUN-A1', 'SESS-A')],
    author_session_ref: 'SESS-A', author_session_executor_type: 'claude',
    last_author_content: 'final page content',
  }));
  const done = await recover(id, { bridge, adapters: { claude: reviewer, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  assert.strictEqual(done.outcome, 'RECOVERED');
  const t = done.task;
  if (t.state !== 'COMPLETED') console.error('[TEST A debug] state:', t.state, '| failure_reason:', t.failure_reason, '| runs:', JSON.stringify(t.runs?.map((r) => [r.purpose, r.status, r.error?.slice(0, 80)])));
  assert.strictEqual(t.state, 'COMPLETED');
  // author was NOT re-run: exactly one author-purpose run, still SESS-A
  const authorRuns = t.runs.filter((r) => r.purpose === 'author');
  assert.strictEqual(authorRuns.length, 1);
  assert.strictEqual(authorRuns[0].session_ref, 'SESS-A');
  // exactly one reviewer run, independent session
  const reviewRuns = t.runs.filter((r) => r.purpose === 'review');
  assert.strictEqual(reviewRuns.length, 1);
  assert.notStrictEqual(reviewRuns[0].session_ref, 'SESS-A');
  assert.strictEqual(bridge.calls.filter((c) => c.kind === 'write_candidate').length, 0, 'workspace task must not touch governance');
});

test('TEST B: NEEDS_FIX persisted -> recover exact-resumes the original author session', async () => {
  const id = `TASK-P4B-${++n}`;
  writeTaskFile(baseTask(id, 'NEEDS_FIX', {
    runs: [authorRun('RUN-B1', 'SESS-B'), reviewRun('RUN-B2', 'REV-B')],
    author_session_ref: 'SESS-B', author_session_executor_type: 'claude',
    last_review: { ...NEEDS_FIX, task_id: id, revision: 1, reviewed_executor_run_id: 'RUN-B2' },
    revisions_used: 2, review_revision: 2,
  }));
  const reviewer = makeFake('claude', [
    { sessionRef: 'REV-B2', review: PASS },
    { sessionRef: 'REV-B3', review: PASS },
  ]);
  const done = await recover(id, { reviewer, adapters: { claude: reviewer, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  assert.strictEqual(done.outcome, 'RECOVERED');
  const t = done.task;
  assert.strictEqual(t.state, 'COMPLETED');
  const fixRuns = t.runs.filter((r) => r.purpose === 'fix');
  assert.strictEqual(fixRuns.length, 1);
  assert.strictEqual(fixRuns[0].session_ref, 'SESS-B', 'fix must exact-resume the original author session');
  // no new author session was created (author-purpose runs still 1 + the fix)
  assert.ok(t.runs.filter((r) => r.purpose === 'author').length === 1);
});

test('TEST C: WAITING_HUMAN survives restart as WAITING_EXTERNAL; nothing re-runs', async () => {
  const id = `TASK-P4C-${++n}`;
  writeTaskFile(baseTask(id, 'WAITING_HUMAN', {
    task_mode: 'governed_write', requires_mcp: true,
    candidate: { title: 't', target: '99-af-e2e/x.md', knowledge_class: 'procedural' },
    governance: { governance_source: 'vault-mcp', candidate_id: 'CAND-C', policy_decision: 'human_required', human_gate_status: null },
    author_session_ref: 'S-C', author_session_executor_type: 'claude',
  }));
  const bridge = makeFakeBridge([{ policy_decision: 'human_required' }]); // gate still open
  const done = await recover(id, { bridge, adapters: { claude: { type: "claude", supportsMcpUnattended: true }, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  assert.strictEqual(done.classification, 'WAITING_EXTERNAL');
  const t = done.task;
  assert.strictEqual(t.state, 'WAITING_HUMAN', 'must stay parked - gate not yet approved');
  assert.strictEqual(t.governance.candidate_id, 'CAND-C', 'correlation preserved');
  assert.strictEqual(bridge.calls.filter((c) => c.kind === 'write_candidate').length, 0, 'no second candidate');
  assert.strictEqual(bridge.calls.filter((c) => c.kind === 'publish_candidate').length, 1, 'one truth re-query, no auto publish');
});

test('TEST D: publish succeeded but COMPLETED never written -> vault truth settles, no double publish', async () => {
  const id = `TASK-P4D-${++n}`;
  writeTaskFile(baseTask(id, 'PUBLISHING', {
    task_mode: 'governed_write', requires_mcp: true,
    candidate: { title: 't', target: '99-af-e2e/x.md', knowledge_class: 'procedural' },
    governance_env: { server_path: 'node', vault_root: '/tmp/af-gov-vault', state_db: '/tmp/af-gov-vault/state.db' },
    governance: {
      governance_source: 'vault-mcp', candidate_id: 'CAND-D',
      policy_decision: 'human_required', published_flag: true,
      published_path: '99-af-e2e/x.md',
      policy_evidence: '{"published":true,"published_path":"99-af-e2e/x.md"}',
    },
    author_session_ref: 'S-D', author_session_executor_type: 'claude',
  }));
  const bridge = makeFakeBridge([], { publishedContent: '# the published page' }); // vault_read confirms
  const done = await recover(id, { bridge, adapters: { claude: { type: "claude", supportsMcpUnattended: true }, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  assert.strictEqual(done.outcome, 'RECOVERED');
  const t = done.task;
  assert.strictEqual(t.state, 'COMPLETED');
  assert.strictEqual(t.governance.publish_status, 'published');
  assert.strictEqual(bridge.calls.filter((c) => c.kind === 'publish_candidate').length, 0, 'publish must NOT be repeated when vault already published');
  assert.ok(bridge.calls.some((c) => c.kind === 'vault_read'), 'settle confirmed via vault truth');
});

test('TEST E: review PASS persisted, acceptance never ran -> recover re-executes acceptance', async () => {
  const id = `TASK-P4E-${++n}`;
  writeTaskFile(baseTask(id, 'REVIEW_RUNNING', {
    last_author_content: 'final page content',
    runs: [authorRun('RUN-E1', 'SESS-E'), reviewRun('RUN-E2', 'REV-E')],
    author_session_ref: 'SESS-E', author_session_executor_type: 'claude',
    last_review: { ...PASS, task_id: id, revision: 1, reviewed_executor_run_id: 'RUN-E2' },
    review_revision: 1,
  }));
  const reviewer = makeFake('claude', [{ sessionRef: 'REV-X', review: PASS }]);
  const done = await recover(id, { reviewer, adapters: { claude: reviewer, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  assert.strictEqual(done.state, 'COMPLETED');
  assert.strictEqual(done.task.acceptance_runs.length, 1, 'deterministic acceptance re-executed once');
  assert.strictEqual(done.task.acceptance_runs[0].exit_code, 0);
  // reviewer was NOT re-called (decision reused from durable state)
  assert.strictEqual(reviewer.calls.filter((c) => c.kind === 'run').length, 0);
});

test('TEST F: a valid lock held by another owner is refused (TASK_ALREADY_RUNNING)', async () => {
  const id = `TASK-P4F-${++n}`;
  writeTaskFile(baseTask(id, 'AUTHOR_RUNNING', {
    runs: [authorRun('RUN-F1', 'SESS-F')],
    author_session_ref: 'SESS-F', author_session_executor_type: 'claude',
    last_author_content: 'content',
  }));
  acquireTaskLock(WORK, id, { orchestratorInstanceId: 'other-orchestrator' });
  const bridge = makeFakeBridge([]);
  const done = await recover(id, { bridge, adapters: { claude: { type: "claude", supportsMcpUnattended: true }, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  assert.strictEqual(done.outcome, 'RECOVERY_ERROR');
  assert.strictEqual(done.code, 'TASK_ALREADY_RUNNING');
  assert.strictEqual(done.task, null, 'lock refusal touches nothing');
  const tf = JSON.parse(readFileSync(join(WORK, `${id}.json`), 'utf8'));
  assert.strictEqual(tf.state, 'AUTHOR_RUNNING', 'durable task untouched');
  assert.strictEqual(bridge.calls.length, 0);
});

test('TEST G: stale lock (dead pid) is recovered with audit evidence', async () => {
  const id = `TASK-P4G-${++n}`;
  writeTaskFile(baseTask(id, 'NEEDS_FIX', {
    runs: [authorRun('RUN-G1', 'SESS-G'), reviewRun('RUN-G2', 'REV-G')],
    author_session_ref: 'SESS-G', author_session_executor_type: 'claude',
    last_review: { ...NEEDS_FIX, task_id: id, revision: 1, reviewed_executor_run_id: 'RUN-G2' },
    revisions_used: 2, review_revision: 2,
  }));
  // stale lock: pid that cannot exist + expired lease
  writeFileSync(join(WORK, `${id}.lock`), JSON.stringify({
    task_id: id, orchestrator_instance_id: 'dead-orch', pid: 999999999,
    acquired_at: '2026-01-01T00:00:00Z', lease_expires_at: '2026-01-01T00:01:00Z',
  }));
  const reviewer = makeFake('claude', [
    { sessionRef: 'REV-G3', review: PASS },
    { sessionRef: 'REV-G4', review: PASS },
  ]);
  const done = await recover(id, { reviewer, adapters: { claude: reviewer, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  assert.strictEqual(done.stale_lock_recovered, true, 'stale lock recovery must be recorded');
  const t = done.task;
  assert.strictEqual(t.state, 'COMPLETED');
  assert.ok(t.recovery_attempts?.some((a) => a.classification === 'RESUMABLE'));
});

test('TEST H: recovering twice is idempotent (no duplicated side effects)', async () => {
  const id = `TASK-P4H-${++n}`;
  writeTaskFile(baseTask(id, 'NEEDS_FIX', {
    runs: [authorRun('RUN-H1', 'SESS-H'), reviewRun('RUN-H2', 'REV-H')],
    author_session_ref: 'SESS-H', author_session_executor_type: 'claude',
    last_review: { ...NEEDS_FIX, task_id: id, revision: 1, reviewed_executor_run_id: 'RUN-H2' },
    revisions_used: 2, review_revision: 2,
  }));
  const reviewer = makeFake('claude', [
    { sessionRef: 'REV-H3', review: PASS },
    { sessionRef: 'REV-H4', review: PASS },
  ]);
  const done1 = await recover(id, { reviewer, adapters: { claude: reviewer, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  console.error('[DBG done1]', JSON.stringify({outcome: done1.outcome, error: done1.error, code: done1.code, classification: done1.classification, state: done1.state}).slice(0, 260));
  assert.strictEqual(done1.task.state, 'COMPLETED');
  const fixesAfterFirst = done1.task.runs.filter((r) => r.purpose === 'fix').length;
  const done2 = await recover(id, { reviewer, adapters: { claude: reviewer, antigravity: realAdapters().antigravity, codex: realAdapters().codex } });
  console.error('[DBG done2]', JSON.stringify({outcome: done2.outcome, error: done2.error, code: done2.code, classification: done2.classification, state: done2.state}).slice(0, 260));
  assert.strictEqual(done2.outcome, 'RECOVERED');
  assert.strictEqual(done2.classification, 'TERMINAL');
  const t2 = readFileSync(join(WORK, `${id}.json`), 'utf8');
  const t2j = JSON.parse(t2);
  assert.strictEqual(t2j.state, 'COMPLETED');
  assert.strictEqual(t2j.runs.filter((r) => r.purpose === 'fix').length, fixesAfterFirst, 'no second fix run');
  assert.strictEqual(t2j.runs.filter((r) => r.purpose === 'review').length, 2, 'no extra reviewer runs');
});

test('TEST I: stale recovery plan (state_version advanced) is aborted, never overwrites', async () => {
  const id = `TASK-P4I-${++n}`;
  const task = baseTask(id, 'NEEDS_FIX', {
    runs: [authorRun('RUN-I1', 'SESS-I'), reviewRun('RUN-I2', 'REV-I')],
    author_session_ref: 'SESS-I', author_session_executor_type: 'claude',
    last_review: { ...NEEDS_FIX, task_id: id, revision: 1, reviewed_executor_run_id: 'RUN-I2' },
    revisions_used: 2, review_revision: 2,
  });
  task.state_version = 8; // another flow advanced the durable state
  writeTaskFile(task);
  // plan made against state_version=5, but another flow advanced it to 8
  const done = await recover(id, { planStateVersion: 5, adapters: { claude: { type: "claude", supportsMcpUnattended: true }, antigravity: { type: "antigravity", supportsMcpUnattended: true }, codex: { type: "codex", supportsMcpUnattended: false } } });
  assert.strictEqual(done.outcome, 'RECOVERY_ERROR');
  assert.strictEqual(done.code, 'STALE_RECOVERY_PLAN');
  const t = JSON.parse(readFileSync(join(WORK, `${id}.json`), 'utf8'));
  assert.strictEqual(t.state_version, 8, 'a stale plan must not advance the durable state');
  assert.strictEqual(t.state, 'NEEDS_FIX', 'state untouched by the stale plan');
});

test('TEST J: interrupted author run is UNKNOWN_OUTCOME, never faked FAILED/PASS', async () => {
  const id = `TASK-P4J-${++n}`;
  writeTaskFile(baseTask(id, 'AUTHOR_RUNNING', {
    runs: [],
    author_session_ref: null, author_session_executor_type: null,
  }));
  const done = await recover(id, { adapters: { claude: { type: "claude", supportsMcpUnattended: true } } });
  assert.strictEqual(done.classification, 'INTERRUPTED');
  assert.strictEqual(done.state, 'AUTHOR_RUNNING');
  assert.strictEqual(done.classification, 'INTERRUPTED', 'INTERRUPTED implies not auto-resumable');
  const t = JSON.parse(readFileSync(join(WORK, `${id}.json`), 'utf8'));
  const intr = t.runs.find((r) => r.execution_outcome === 'interrupted');
  assert.ok(intr, 'an interrupted run placeholder must be recorded');
  assert.strictEqual(intr.status, 'interrupted');
  assert.notStrictEqual(t.state, 'COMPLETED');
  assert.notStrictEqual(t.state, 'FAILED');
});

test('availability gate: exact-resume recovery with an UNAVAILABLE executor is UNSAFE (agy 403)', async () => {
  const { loadExecutorStatus, } = await import('../lib/executor-status.mjs');
  void loadExecutorStatus;
  const availability = { antigravity: { availability_status: 'UNAVAILABLE', reason: 'ACCOUNT_DISABLED_403' } };
  const id = `TASK-P4K-${++n}`;
  const task = baseTask(id, 'NEEDS_FIX', {
    author_executor: 'antigravity', reviewer_executor: 'claude',
    author_session_executor_type: 'antigravity', author_session_ref: 'AGY-SESS',
    runs: [authorRun('RUN-K1', 'AGY-SESS'), reviewRun('RUN-K2', 'REV-K')],
    last_review: { ...NEEDS_FIX, task_id: id, revision: 1, reviewed_executor_run_id: 'RUN-K2' },
    revisions_used: 2, review_revision: 2,
  });
  writeTaskFile(task);
  // recovery classifies the exact-resume as unsafe and executes nothing:
  // the durable state must remain untouched (no fake swap, no fake resume)
  const done = await recover(id, { availability });
  assert.strictEqual(done.outcome, 'RECOVERED'); // recovery ran to classify & refuse
  assert.strictEqual(done.task.state, 'NEEDS_FIX', 'no exact-resume was attempted');
  assert.strictEqual(done.task.recovery_attempts.at(-1).classification, 'UNSAFE_TO_AUTO_RESUME');
  assert.strictEqual(done.task.state, 'NEEDS_FIX', 'no exact-resume was attempted');
});
