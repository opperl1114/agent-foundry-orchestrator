// real-host-cancel.mjs - PHASE 4 Cancellation Real-Host Closure
// Real Claude adapter + real subprocess signals + cross-process CLI cancel.
// No fake adapters. Run inside WSL:
//   cd /mnt/c/Users/relaret/agent-foundry-orchestrator
//   export PATH=/home/relaret/.nvm/versions/node/v24.20.0/bin:/usr/bin:/bin
//   node tests/real-host-cancel.mjs RHC1|RHC2|RHC3|ALL
// Exit 0 = PASS, 1 = FAIL. Evidence printed as JSON.
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_DIR = join(ROOT, 'tasks');
const RUNS_DIR = join(ROOT, 'runtime', 'runs');
const FIX_SH = join(ROOT, 'fixtures', 'make-fixture.sh');
const GOV_SH = join(ROOT, 'fixtures', 'make-governed-fixture.sh');
const RUNTAG = Date.now().toString(36);

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim();
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bgProcs = [];

function spawnBg(cmd) {
  const child = spawn('/bin/bash', ['-lc', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => out.push(d));
  bgProcs.push(child);
  return { child, dump: () => out.join('').slice(-4000) };
}

async function waitFor(label, fn, timeoutMs = 120000, stepMs = 1500) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${label} (${timeoutMs}ms)`);
    await sleep(stepMs);
  }
}

function cleanupBg() {
  for (const c of bgProcs) {
    try { c.kill('SIGTERM'); } catch { /* gone */ }
  }
  // failure-path backstop: kill only OUR run CLI processes (and their child
  // launcher processes) by the exact /tmp/af-rc task-file pattern - never a
  // platform-wide claude kill
  try { sh(`pkill -TERM -f 'node orchestrator.mjs run --task-file /tmp/af-rc' || true`); } catch { /* none */ }
  const t0 = Date.now();
  for (;;) {
    if (bgProcs.every((c) => c.exitCode !== null)) break;
    if (Date.now() - t0 > 5000) break;
  }
  for (const c of bgProcs) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* gone */ }
  }
  try { sh(`pkill -KILL -f 'node orchestrator.mjs run --task-file /tmp/af-rc' || true`); } catch { /* none */ }
}

function readTask(tid) {
  return JSON.parse(readFileSync(join(TASKS_DIR, `${tid}.json`), 'utf8'));
}

function findHandles(tid) {
  const out = [];
  try {
    for (const f of readdirSync(RUNS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const h = JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8'));
        if (h.task_id === tid) out.push(h);
      } catch { /* corrupt */ }
    }
  } catch { /* no runs dir yet */ }
  return out;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cancelCli(tid, extra = '') {
  // CLI exits 2 when the task is already terminal at the FIRST read (cancel
  // refused - terminal state untouched) and 0 when a race was detected at the
  // final re-read (terminal state kept). Both are legal; never throw here.
  try {
    return { out: sh(`cd ${JSON.stringify(ROOT)} && node orchestrator.mjs cancel --task-id ${tid} ${extra}`), code: 0 };
  } catch (e) {
    return { out: e.stdout ?? '', code: e.status ?? -1 };
  }
}

function lastJsonBlock(s) {
  // CLI JSON output is pretty-printed (JSON.stringify(x, null, 2)) - take the
  // whole block from the first { to the last }, not a single line.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`no JSON block in output: ${s.slice(0, 300)}`);
  return JSON.parse(s.slice(start, end + 1));
}

const GOV_ENV = {
  server_path: '/mnt/c/Users/relaret/vault-mcp/server.mjs',
  vault_root: '/tmp/af-rc3-gov',
  state_db: '/tmp/af-rc3-gov/state.db',
  reviewer_mcp_config: '/tmp/af-rc3-mcp.json',
  reviewer_allowed_tools: 'mcp__agent-foundry-vault-fixture__agent_register,mcp__agent-foundry-vault-fixture__review_candidate',
  reviewer_server_name: 'agent-foundry-vault-fixture',
};

// RHC3 owns an isolated fixture vault; the reviewer's MCP server must point at
// THAT vault, not the shared fixtures/fixture-vault-mcp.json (which is pinned
// to the R2/R3 fixture path /tmp/af-gov-vault).
function writeRHC3McpConfig() {
  writeFileSync('/tmp/af-rc3-mcp.json', JSON.stringify({
    mcpServers: {
      'agent-foundry-vault-fixture': {
        command: 'node',
        args: ['/mnt/c/Users/relaret/vault-mcp/server.mjs'],
        env: { VAULT_ROOT: '/tmp/af-rc3-gov', VAULT_MCP_STATE_DB: '/tmp/af-rc3-gov/state.db' },
      },
    },
  }, null, 2));
}

const REAL_VAULT_INBOX = '/mnt/c/Users/relaret/agent-foundry-vault/10-\u6536\u4ef6\u7bb1/\u5199\u56de\u5019\u9009';
const REAL_STATE_DB = '/home/relaret/.local/share/agent-foundry-mcp/state.db';

function realVaultTouchCheck() {
  let inbox = '';
  try { inbox = sh(`ls '${REAL_VAULT_INBOX}'`); } catch { /* ignore */ }
  const leaked = inbox.split('\n').filter((f) => /RCC|RHC/i.test(f));
  let dbRows = null;
  try {
    dbRows = execSync(`node --experimental-sqlite -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("${REAL_STATE_DB}");
const i = db.prepare("SELECT agent_instance_id FROM agent_instances WHERE task_id LIKE ?").all("TASK-RCC%");
const c = db.prepare("SELECT candidate_id FROM candidates WHERE task_id LIKE ?").all("TASK-RCC%");
console.log(JSON.stringify({ instances: i.length, candidates: c.length }));'`,
      { encoding: 'utf8', shell: '/bin/bash' });
  } catch (e) { dbRows = `check_error: ${String(e.message).slice(0, 120)}`; }
  return { leaked_files: leaked, real_state_db: dbRows, zero_touch: leaked.length === 0 };
}

// ------------------------------------------------ RHC1: slow-run cancel + isolation
async function rhc1() {
  const tag = RUNTAG;
  const tidA = `TASK-RCC-SLOW-${tag}`;
  const tidB = `TASK-RCC-FAST-${tag}`;
  sh(`bash '${FIX_SH}' /tmp/af-rc1-a >/dev/null 2>&1`);
  sh(`bash '${FIX_SH}' /tmp/af-rc1-b >/dev/null 2>&1`);
  const slowTask = {
    task_id: tidA, task_mode: 'workspace',
    goal: "Fix the bug in calc.js: add(a, b) must return a + b instead of a - b. Keep the change minimal. Work step by step: (1) run `node --test calc.test.js` and observe the failure, (2) edit calc.js so add() returns a + b, (3) run `node --test calc.test.js` again to confirm both tests pass. Do not skip the test runs.",
    acceptance: "node --test calc.test.js passes all tests.",
    acceptance_cmd: { command: 'node', args: ['--test', 'calc.test.js'] },
    red_lines: ['Only modify files inside the fixture directory', 'Do not delete or weaken the existing tests'],
    review_rules: ['calc.js: add(a,b) returns a + b (cite file:line)', 'calc.test.js unchanged and still asserts add(1,2)===3 and add(0,0)===0'],
    fixture_dir: '/tmp/af-rc1-a',
    requires_mcp: false, author_executor: 'claude', reviewer_executor: 'claude', max_revisions: 2,
  };
  const fastTask = {
    task_id: tidB, task_mode: 'workspace',
    goal: "Fix the bug in calc.js: add(a, b) must return a + b instead of a - b. Keep the change minimal. First line of calc.js must stay a comment describing add().",
    acceptance: "node --test calc.test.js passes all tests.",
    acceptance_cmd: { command: 'node', args: ['--test', 'calc.test.js'] },
    red_lines: ['Only modify files inside the fixture directory', 'Do not delete or weaken the existing tests'],
    review_rules: [
      'calc.js: add(a,b) returns a + b (cite file:line)',
      'calc.test.js is unchanged and still asserts add(1,2)===3 and add(0,0)===0',
    ],
    fixture_dir: '/tmp/af-rc1-b', requires_mcp: false,
    author_executor: 'claude', reviewer_executor: 'claude', max_revisions: 3,
  };
  writeFileSync('/tmp/af-rc1-a.json', JSON.stringify(slowTask));
  writeFileSync('/tmp/af-rc1-b.json', JSON.stringify(fastTask));
  mkdirSync(TASKS_DIR, { recursive: true });

  const bgA = spawnBg(`cd ${JSON.stringify(ROOT)} && node orchestrator.mjs run --task-file /tmp/af-rc1-a.json`);
  await sleep(1000);
  const bgB = spawnBg(`cd ${JSON.stringify(ROOT)} && node orchestrator.mjs run --task-file /tmp/af-rc1-b.json`);

  const handleA = await waitFor('RHC1 slow run handle', () => findHandles(tidA)[0] ?? null, 120000);
  const handleB = await waitFor('RHC1 fast run handle', () => findHandles(tidB)[0] ?? null, 120000);
  await waitFor('RHC1 A AUTHOR_RUNNING', () => { try { return readTask(tidA).state === 'AUTHOR_RUNNING'; } catch { return false; } }, 60000);
  await sleep(2000); // let both processes settle past spawn

  const pre = { pidA_alive: alive(handleA.pid), pidB_alive: alive(handleB.pid) };
  const cancel = lastJsonBlock(cancelCli(tidA).out);

  // process must actually die
  const died = await waitFor('RHC1 pidA death', () => !alive(handleA.pid), 15000, 500);
  // chain convergence signature: the executor process classified the exit as
  // RUN_CANCELLED and recordRun persisted a cancelled author run (this is what
  // distinguishes CANCELLED from a crash-FAILED in the runs ledger).
  const taskAfter = await waitFor('RHC1 A chain convergence', () => {
    try {
      const t = readTask(tidA);
      return t.runs?.some((r) => r.purpose === 'author' && r.status === 'cancelled') ? t : null;
    } catch { return null; }
  }, 60000);
  const pidBAliveAfterCancel = alive(handleB.pid);

  const taskB = await waitFor('RHC1 B COMPLETED', () => { try { const t = readTask(tidB); return t.state === 'COMPLETED' ? t : null; } catch { return null; } }, 420000);

  const runsA = taskAfter.runs ?? [];
  const authorA = runsA.find((r) => r.purpose === 'author');
  const handleAGoneAfter = !existsSync(join(RUNS_DIR, `${handleA.run_id}.json`));
  const pass = pre.pidA_alive && pre.pidB_alive
    && cancel.termination?.identity_confirmed === true
    && cancel.termination?.pid === handleA.pid
    && ['SIGTERM', 'SIGKILL'].includes(cancel.termination?.signal)
    && cancel.termination?.observed_exit === true
    && taskAfter.state === 'CANCELLED'
    && authorA?.status === 'cancelled' && authorA?.executor_run_id === handleA.run_id
    && died
    && handleAGoneAfter
    && pidBAliveAfterCancel
    && taskB.state === 'COMPLETED' && !taskB.failure_reason
    && taskB.runs.some((r) => r.purpose === 'review' && r.status === 'completed');
  const report = {
    test: 'RHC1', pass,
    slow_task: tidA, fast_task: tidB,
    handle_A: { run_id: handleA.run_id, pid: handleA.pid, adapter_type: handleA.adapter_type },
    handle_B: { run_id: handleB.run_id, pid: handleB.pid, adapter_type: handleB.adapter_type },
    pre_cancel_alive: pre,
    cancel_evidence: cancel.termination,
    A_state: taskAfter.state,
    A_author_run: authorA ? `${authorA.status}:${authorA.executor_run_id}` : null,
    A_cancelled_at: taskAfter.cancelled_at ?? null,
    pidA_dead_after: !alive(handleA.pid),
    handleA_removed_after: handleAGoneAfter,
    pidB_alive_after_cancel: pidBAliveAfterCancel,
    B_state: taskB.state, B_failure: taskB.failure_reason ?? null,
    B_runs: taskB.runs.map((r) => `${r.purpose}:${r.status}`),
    A_runs: runsA.map((r) => `${r.purpose}:${r.status}`),
  };
  console.log(JSON.stringify(report, null, 1));
  return pass;
}

// ------------------------------------------------ RHC2: race, both directions
async function rhc2() {
  const tag = RUNTAG;
  // Direction 1: cancel AFTER natural completion must never downgrade COMPLETED
  const tidR1 = `TASK-RCC-RACE1-${tag}`;
  const fastTask = {
    task_id: tidR1, task_mode: 'workspace',
    goal: "Fix the bug in calc.js: add(a, b) must return a + b instead of a - b. Keep the change minimal.",
    acceptance: "node --test calc.test.js passes all tests.",
    acceptance_cmd: { command: 'node', args: ['--test', 'calc.test.js'] },
    red_lines: ['Only modify files inside the fixture directory'],
    review_rules: ['calc.js: add(a,b) returns a + b (cite file:line)', 'calc.test.js unchanged'],
    fixture_dir: '/tmp/af-rc1-b', requires_mcp: false,
    author_executor: 'claude', reviewer_executor: 'claude', max_revisions: 3,
  };
  sh(`bash '${FIX_SH}' /tmp/af-rc1-b >/dev/null 2>&1`);
  writeFileSync('/tmp/af-rc2-r1.json', JSON.stringify(fastTask));
  mkdirSync(TASKS_DIR, { recursive: true });
  spawnBg(`cd ${JSON.stringify(ROOT)} && node orchestrator.mjs run --task-file /tmp/af-rc2-r1.json`);
  await waitFor('RHC2-d1 COMPLETED', () => { try { return readTask(tidR1).state === 'COMPLETED' ? true : null; } catch { return null; } }, 420000);
  const afterD1 = (() => {
    const res = cancelCli(tidR1);
    const d1cancel = res.code === 0 ? lastJsonBlock(res.out) : null;
    const t = readTask(tidR1);
    return { cancel: d1cancel, code: res.code, task: t };
  })();
  const d1 = {
    state_kept: afterD1.task.state === 'COMPLETED',
    not_downgraded_to_cancelled: afterD1.task.state !== 'CANCELLED',
    cancelled_at_not_written: !afterD1.task.cancelled_at,
    cancel_cli_exit: afterD1.code, // 0 = race-kept path, 2 = refused-at-first-read path
    pass: afterD1.task.state === 'COMPLETED' && !afterD1.task.cancelled_at,
  };

  // Direction 2: cancel DURING a run must stick - no late completion overwrite
  const tidR2 = `TASK-RCC-RACE2-${tag}`;
  const slowTask = {
    task_id: tidR2, task_mode: 'workspace',
    goal: "Fix the bug in calc.js: add(a, b) must return a + b instead of a - b. Keep the change minimal. Work step by step: (1) run `node --test calc.test.js` and observe the failure, (2) edit calc.js so add() returns a + b, (3) run `node --test calc.test.js` again to confirm both tests pass. Do not skip the test runs.",
    acceptance: "node --test calc.test.js passes all tests.",
    acceptance_cmd: { command: 'node', args: ['--test', 'calc.test.js'] },
    red_lines: ['Only modify files inside the fixture directory', 'Do not delete or weaken the existing tests'],
    review_rules: ['calc.js: add(a,b) returns a + b (cite file:line)', 'calc.test.js unchanged'],
    fixture_dir: '/tmp/af-rc1-a',
    requires_mcp: false, author_executor: 'claude', reviewer_executor: 'claude', max_revisions: 2,
  };
  writeFileSync('/tmp/af-rc2-r2.json', JSON.stringify(slowTask));
  spawnBg(`cd ${JSON.stringify(ROOT)} && node orchestrator.mjs run --task-file /tmp/af-rc2-r2.json`);
  const h = await waitFor('RHC2-d2 handle', () => findHandles(tidR2)[0] ?? null, 120000);
  await sleep(2000);
  const cancelD2 = lastJsonBlock(cancelCli(tidR2).out);
  const snap = readTask(tidR2);
  const snapUpdatedAt = snap.updated_at ?? snap.state_version ?? null;
  await waitFor('RHC2-d2 cancelled author run persisted', () => {
    try {
      const t = readTask(tidR2);
      return t.runs?.some((r) => r.purpose === 'author' && r.status === 'cancelled') ? true : null;
    } catch { return null; }
  }, 60000);
  await sleep(45000); // long enough for any stale completion write to land
  const afterD2 = readTask(tidR2);
  const d2 = {
    cancel_evidence: cancelD2.termination,
    state: afterD2.state,
    still_cancelled_after_45s: afterD2.state === 'CANCELLED',
    no_run_added_after_cancel: afterD2.runs.length === snap.runs.length,
    file_not_rewritten: (afterD2.updated_at ?? afterD2.state_version ?? null) === snapUpdatedAt,
    pass: afterD2.state === 'CANCELLED' && afterD2.runs.length === snap.runs.length,
  };
  const pass = d1.pass && d2.pass;
  const report = { test: 'RHC2', pass, direction1: d1, direction2: d2 };
  console.log(JSON.stringify(report, null, 1));
  return pass;
}

// ------------------------------------------------ RHC3: governance preservation
async function rhc3() {
  const tag = RUNTAG;
  const tid = `TASK-RCC-L3-${tag}`;
  sh(`bash '${GOV_SH}' /tmp/af-rc3-gov >/dev/null 2>&1`);
  writeRHC3McpConfig();
  const l3 = {
    task_id: tid, task_mode: 'governed_write',
    goal: "Write the documentation page 'About the 99-af-e2e fixture area' for this fixture vault. First line must be: '> Agent Foundry Orchestrator E2E tooling - description of the 99-af-e2e fixture area.' Content must state accurately: (1) 99-af-e2e/ holds throwaway artifacts of governed-write E2E probes; (2) targets under it are unmatched by the L2 path rules so policy classifies them L3-governed and requires a real Human Gate; (3) cleanup is a full fixture reset via fixtures/make-governed-fixture.sh. Only reference this target path (99-af-e2e/af-rc3-gate-probe.md).",
    acceptance: "Author produces the page content; QA review passes; policy decides.",
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: ['Only fixture content'],
    review_rules: [
      "The page's first line is the required tooling marker",
      'The page accurately describes the 99-af-e2e area purpose, the L3/human-gate consequence, and the fixture-reset cleanup',
      'PASS if both hold - real tool documentation sourced from the task definition',
    ],
    fixture_dir: '/tmp/af-rc3-gov', requires_mcp: true,
    author_executor: 'claude', reviewer_executor: 'claude', max_revisions: 2,
    candidate: {
      title: 'About the 99-af-e2e fixture area (RHC3 probe)',
      target: '99-af-e2e/af-rc3-gate-probe.md',
      knowledge_class: 'procedural',
      sources: ['agent-foundry-orchestrator/fixtures/make-governed-fixture.sh'],
      publish_tags: ['tooling', 'agent-harness'],
      publish_summary: 'RHC3 cancellation governance-boundary probe',
      rationale: 'PHASE 4 real-host cancellation governance probe',
    },
    governance_env: GOV_ENV,
  };
  writeFileSync('/tmp/af-rc3-l3.json', JSON.stringify(l3));
  mkdirSync(TASKS_DIR, { recursive: true });
  spawnBg(`cd ${JSON.stringify(ROOT)} && node orchestrator.mjs run --task-file /tmp/af-rc3-l3.json`);

  await waitFor('RHC3 WAITING_HUMAN', () => { try { const t = readTask(tid); return t.state === 'WAITING_HUMAN' ? t : null; } catch { return null; } }, 720000);
  const waiting = readTask(tid);
  const govSnapshot = JSON.stringify(waiting.governance ?? null);
  const candId = waiting.governance?.candidate_id ?? null;
  const policyDecision = waiting.governance?.policy_decision ?? null;
  const policyEvidence = waiting.governance?.policy_evidence ?? null;

  const cancel = lastJsonBlock(cancelCli(tid).out);
  const after = readTask(tid);
  const govAfter = JSON.stringify(after.governance ?? null);

  let dbRow = null;
  try {
    dbRow = execSync(`node --experimental-sqlite -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/tmp/af-rc3-gov/state.db");
const c = db.prepare("SELECT candidate_id, task_id, mode FROM candidates WHERE task_id = ?").all("${tid}");
console.log(JSON.stringify(c));'`, { encoding: 'utf8', shell: '/bin/bash' });
  } catch (e) { dbRow = `check_error: ${String(e.message).slice(0, 120)}`; }

  const parsed = (() => { try { return JSON.parse(dbRow); } catch { return []; } })();
  const candidateKept = parsed.length === 1 && parsed[0].candidate_id === candId;
  const neverPublished = !(policyEvidence && (() => { try { return JSON.parse(policyEvidence).published === true; } catch { return false; } })());

  const pass = waiting.state === 'WAITING_HUMAN'
    && after.state === 'CANCELLED'
    && govAfter === govSnapshot
    && cancel.termination?.already_exited === true
    && candidateKept && neverPublished;
  const report = {
    test: 'RHC3', pass,
    waiting_state: waiting.state,
    cancelled_state: after.state,
    candidate_id: candId,
    policy_decision: policyDecision,
    governance_preserved_byte_equal: govAfter === govSnapshot,
    cancel_termination: cancel.termination,
    fixture_db_candidate: parsed,
    candidate_kept: candidateKept,
    never_published: neverPublished,
    real_vault_zero_touch: realVaultTouchCheck(),
  };
  console.log(JSON.stringify(report, null, 1));
  return pass;
}

const which = process.argv[2] ?? 'ALL';
const runners = { RHC1: rhc1, RHC2: rhc2, RHC3: rhc3, ALL: () => Promise.all([rhc1(), rhc2(), rhc3()]).then((rs) => rs.every(Boolean)) };
const runner = runners[which];
if (!runner) { console.error('usage: node tests/real-host-cancel.mjs RHC1|RHC2|RHC3|ALL'); process.exit(2); }

runner()
  .then((pass) => {
    cleanupBg();
    if (!pass) { console.error(`${which}: FAIL`); process.exit(1); }
    console.error(`${which}: PASS`);
    process.exit(0);
  })
  .catch((e) => {
    cleanupBg();
    console.error('FATAL:', e?.message ?? e);
    process.exit(1);
  });
