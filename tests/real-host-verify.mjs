// real-host-verify.mjs - PHASE 3 Real-Host Verification (R1/R2/R3)
// Drives the REAL Scheduler + REAL adapters (Claude via claude-ccs, real
// hermetic vault-mcp for governed tasks). No fake adapters, no fake bridges.
// Usage: node tests/real-host-verify.mjs R1|R2|R3
// Exit code 0 = that test PASSed; 1 = FAILED; assertions printed as JSON.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scheduler } from '../lib/scheduler.mjs';
import { saveTaskAtomic } from '../lib/store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX_SH = join(ROOT, 'fixtures', 'make-fixture.sh');
const GOV_SH = join(ROOT, 'fixtures', 'make-governed-fixture.sh');
const GOV_ENV_BASE = {
  server_path: '/mnt/c/Users/relaret/vault-mcp/server.mjs',
  vault_root: '/tmp/af-gov-vault',
  state_db: '/tmp/af-gov-vault/state.db',
  reviewer_mcp_config: join(ROOT, 'fixtures', 'fixture-vault-mcp.json'),
  reviewer_allowed_tools: 'mcp__agent-foundry-vault-fixture__agent_register,mcp__agent-foundry-vault-fixture__review_candidate',
  reviewer_server_name: 'agent-foundry-vault-fixture',
};

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const now = () => new Date().toISOString();
const REAL_VAULT_INBOX = '/mnt/c/Users/relaret/agent-foundry-vault/10-收件箱/写回候选';
const REAL_STATE_DB = '/home/relaret/.local/share/agent-foundry-mcp/state.db';

function realVaultTouchCheck() {
  // zero-touch: no new fixture-named candidates in the real vault inbox, and
  // no TASK-REAL* instances in the real state.db
  let inbox = '';
  try { inbox = sh(`ls '${REAL_VAULT_INBOX}'`); } catch { /* ignore */ }
  const leakedFiles = inbox.split('\n').filter((f) => /REAL|af-gov/i.test(f));
  let dbRows = null;
  try {
    dbRows = execSync(`node --experimental-sqlite -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("${REAL_STATE_DB}");
const i = db.prepare("SELECT agent_instance_id FROM agent_instances WHERE task_id LIKE ?").all("TASK-REAL%");
const c = db.prepare("SELECT candidate_id FROM candidates WHERE title LIKE ? OR task_id LIKE ?").all("%REAL%", "TASK-REAL%");
console.log(JSON.stringify({ instances: i.length, candidates: c.length }));'`,
      { encoding: 'utf8' });
  } catch (e) { dbRows = `check_error: ${String(e.message).slice(0, 100)}`; }
  return { leaked_files: leakedFiles, real_state_db: dbRows, zero_touch: leakedFiles.length === 0 };
}

// ---------------------------------------------------------------- R1
async function runR1() {
  sh(`bash '${FIX_SH}' /tmp/af-r1-a >/dev/null 2>&1`);
  sh(`bash '${FIX_SH}' /tmp/af-r1-b >/dev/null 2>&1`);
  const mk = (id, dir) => ({
    task_id: id,
    goal: "Fix the bug in calc.js: add(a, b) must return a + b instead of a - b. Keep the change minimal. First line of calc.js must stay a comment describing add().",
    acceptance: "node --test calc.test.js passes all tests.",
    acceptance_cmd: { command: 'node', args: ['--test', 'calc.test.js'] },
    red_lines: ['Only modify files inside the fixture directory', 'Do not delete or weaken the existing tests'],
    review_rules: [
      'calc.js: add(a,b) returns a + b (cite file:line)',
      'calc.test.js is unchanged and still asserts add(1,2)===3 and add(0,0)===0',
      'STYLE_RULE: every exported function in calc.js must carry a JSDoc block comment (/** ... */) with at least one description line; a plain // line comment does NOT satisfy this rule',
    ],
    fixture_dir: dir,
    requires_mcp: false,
    author_executor: 'claude',
    reviewer_executor: 'claude',
    max_revisions: 3,
  });
  const taskA = mk('TASK-RUN-A', '/tmp/af-r1-a');
  const taskB = mk('TASK-RUN-B', '/tmp/af-r1-b');

  const scheduler = new Scheduler({ maxConcurrent: 2, adapters: (await import('../lib/adapters.mjs')).ADAPTERS });
  scheduler.enqueue(taskA);
  scheduler.enqueue(taskB);
  scheduler.runNext();
  await scheduler.waitAll();

  const a = JSON.parse(readFileSync(join(ROOT, 'tasks', 'TASK-RUN-A.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(ROOT, 'tasks', 'TASK-RUN-B.json'), 'utf8'));

  // session isolation assertions
  const sessionMap = (t) => t.runs.map((r) => ({
    task_id: t.task_id, executor_run_id: r.executor_run_id, assigned_role: r.assigned_role,
    purpose: r.purpose, executor_type: r.executor_type, session_ref: r.session_ref, status: r.status,
  }));
  const runsA = sessionMap(a);
  const runsB = sessionMap(b);
  const allRuns = [...runsA, ...runsB];
  const sessions = allRuns.map((r) => `${r.task_id}:${r.purpose}:${r.session_ref}`);
  const uniqueSessions = new Set(sessions.filter((s) => !s.endsWith('null'))).size;

  const authorA = a.runs.find((r) => r.purpose === 'author');
  const authorB = b.runs.find((r) => r.purpose === 'author');
  const fixA = a.runs.find((r) => r.purpose === 'fix');
  const reviewerA = a.runs.find((r) => r.purpose === 'review');
  const crossTaskSessionLeak = authorA.session_ref && authorB.session_ref && authorA.session_ref === authorB.session_ref;
  const intraTaskLeak = reviewerA.session_ref && authorA.session_ref && reviewerA.session_ref === authorA.session_ref;
  const fixResumedOwn = !fixA || fixA.session_ref === authorA.session_ref; // exact resume of own author session

  const needsFixSeen = [...a.runs, ...b.runs].some((r) => false) // runs do not carry decision; use last_review / revisions
    || (a.last_review?.decision === 'NEEDS_FIX' || b.last_review?.decision === 'NEEDS_FIX')
    || a.revisions_used > 1 || b.revisions_used > 1
    || (a.runs.some((r) => r.purpose === 'fix') || b.runs.some((r) => r.purpose === 'fix'));

  const report = {
    test: 'R1', state_A: a.state, state_B: b.state,
    revisions_A: a.revisions_used, revisions_B: b.revisions_used,
    needs_fix_exercised: !!needsFixSeen,
    fix_resumed_own_author_session: fixResumedOwn,
    cross_task_session_leak: !!crossTaskSessionLeak,
    intra_task_author_reviewer_session_leak: !!intraTaskLeak,
    unique_session_refs: uniqueSessions,
    failure_reasons: [a.failure_reason, b.failure_reason].filter(Boolean),
    runs: allRuns,
  };
  const pass = a.state === 'COMPLETED' && b.state === 'COMPLETED'
    && !crossTaskSessionLeak && !intraTaskLeak && fixResumedOwn
    && needsFixSeen && uniqueSessions === allRuns.filter((r) => r.session_ref).length;
  console.log(JSON.stringify(report, null, 1));
  if (!pass) { console.error('R1: FAIL'); process.exit(1); }
  console.error('R1: PASS');
}

// ---------------------------------------------------------------- R2
async function runR2() {
  sh(`bash '${GOV_SH}' /tmp/af-gov-vault >/dev/null 2>&1`);
  sh(`bash '${FIX_SH}' /tmp/af-r2-ws >/dev/null 2>&1`);
  const RUNTAG = Date.now().toString(36);
  const workspaceTask = {
    task_id: `TASK-REAL-WS-${RUNTAG}`,
    goal: "Fix the bug in calc.js: add(a, b) must return a + b instead of a - b. Keep the change minimal.",
    acceptance: "node --test calc.test.js passes all tests.",
    acceptance_cmd: { command: 'node', args: ['--test', 'calc.test.js'] },
    red_lines: ['Only modify files inside the fixture directory'],
    review_rules: ['calc.js: add(a,b) returns a + b (cite file:line)', 'calc.test.js unchanged and still asserts the two cases'],
    fixture_dir: '/tmp/af-r2-ws',
    requires_mcp: false,
    author_executor: 'claude',
    reviewer_executor: 'claude',
    max_revisions: 3,
  };
  const l3Task = {
    task_id: `TASK-REAL-L3-${RUNTAG}`,
    task_mode: 'governed_write',
    goal: "Write the documentation page 'About the 99-af-e2e fixture area' for this fixture vault. First line must be: '> Agent Foundry Orchestrator E2E tooling - description of the 99-af-e2e fixture area.' Content must state accurately: (1) 99-af-e2e/ holds throwaway artifacts of governed-write E2E probes; (2) targets under it are unmatched by the L2 path rules so policy classifies them L3-governed and requires a real Human Gate; (3) cleanup is a full fixture reset via fixtures/make-governed-fixture.sh. Only reference this target path (99-af-e2e/af-l3-gate-probe.md).",
    acceptance: "Author produces the page content; QA review passes; policy decides.",
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: ['Only fixture content'],
    review_rules: [
      "The page's first line is the required tooling marker",
      'The page accurately describes the 99-af-e2e area purpose, the L3/human-gate consequence, and the fixture-reset cleanup',
      'PASS if both hold - this is real tool documentation sourced from the task definition',
    ],
    fixture_dir: '/tmp/af-gov-vault',
    requires_mcp: true,
    author_executor: 'claude',
    reviewer_executor: 'claude',
    max_revisions: 2,
    candidate: {
      title: 'About the 99-af-e2e fixture area',
      target: '99-af-e2e/af-l3-gate-probe.md',
      knowledge_class: 'procedural',
      sources: ['agent-foundry-orchestrator/fixtures/make-governed-fixture.sh', 'agent-foundry-orchestrator/tasks/gov-l3.json'],
      publish_tags: ['tooling', 'agent-harness'],
      publish_summary: 'Purpose and cleanup of the 99-af-e2e fixture area (R2 real-host probe)',
      rationale: 'PHASE 3 R2 real-host probe',
    },
    governance_env: GOV_ENV_BASE,
  };

  const scheduler = new Scheduler({ maxConcurrent: 2, adapters: (await import('../lib/adapters.mjs')).ADAPTERS });
  scheduler.enqueue(workspaceTask);
  scheduler.enqueue(l3Task);
  scheduler.runNext();
  await scheduler.waitAll();

  const ws = JSON.parse(readFileSync(join(ROOT, 'tasks', `TASK-REAL-WS-${RUNTAG}.json`), 'utf8'));
  const l3 = JSON.parse(readFileSync(join(ROOT, 'tasks', `TASK-REAL-L3-${RUNTAG}.json`), 'utf8'));
  const status = scheduler.status();

  const report = {
    test: 'R2',
    workspace_state: ws.state,
    l3_state: l3.state,
    l3_candidate_id: l3.governance?.candidate_id ?? null,
    l3_policy_decision: l3.governance?.policy_decision ?? null,
    l3_effective_write_class: (() => { try { return JSON.parse(l3.governance.policy_evidence).effective_write_class; } catch { return null; } })(),
    l3_published: (() => { try { return JSON.parse(l3.governance.policy_evidence).published; } catch { return null; } })(),
    scheduler_waiting_after: status.waiting,
    scheduler_active_after: status.active,
    slot_released_on_waiting: status.waiting.includes('TASK-REAL-L3') && !status.active.includes('TASK-REAL-L3'),
    failure_reasons: [ws.failure_reason, l3.failure_reason].filter(Boolean),
  };
  const pass = ws.state === 'COMPLETED' && l3.state === 'WAITING_HUMAN'
    && !!report.l3_candidate_id && report.l3_policy_decision === 'human_required'
    && report.slot_released_on_waiting;
  console.log(JSON.stringify(report, null, 1));
  if (!pass) { console.error('R2: FAIL'); process.exit(1); }
  console.error('R2: PASS');
}

// ---------------------------------------------------------------- R3
async function runR3() {
  sh(`bash '${GOV_SH}' /tmp/af-gov-vault >/dev/null 2>&1`);
  const RUNTAG = Date.now().toString(36);
  const mk = (id, target, title) => ({
    task_id: id,
    task_mode: 'governed_write',
    goal: `Write the documentation page '${title}' for this fixture vault. First line must be: '> Agent Foundry Orchestrator E2E tooling - fixture area documentation.' Content must state accurately: 99-af-e2e/ holds throwaway artifacts of governed-write E2E probes; targets under it are unmatched by L2 path rules so policy classifies them L3-governed and requires a real Human Gate; cleanup is a full fixture reset via fixtures/make-governed-fixture.sh. Only reference this target path (${target}).`,
    acceptance: "Author produces the page content; QA review passes; policy decides.",
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    red_lines: ['Only fixture content'],
    review_rules: [
      "The page's first line is the required tooling marker",
      'The page accurately describes the area purpose, L3/human-gate consequence, and cleanup',
      'PASS if both hold - real tool documentation sourced from the task definition',
    ],
    fixture_dir: '/tmp/af-gov-vault',
    requires_mcp: true,
    author_executor: 'claude',
    reviewer_executor: 'claude',
    max_revisions: 2,
    candidate: {
      title,
      target,
      knowledge_class: 'procedural',
      sources: ['agent-foundry-orchestrator/fixtures/make-governed-fixture.sh', `agent-foundry-orchestrator/tasks/${id.toLowerCase()}.json`],
      publish_tags: ['tooling', 'agent-harness'],
      publish_summary: `${title} (R3 real-host correlation probe)`,
      rationale: 'PHASE 3 R3 real-host governed correlation probe',
    },
    governance_env: GOV_ENV_BASE,
  });
  const taskA = mk('TASK-REAL-GOV-A', '99-af-e2e/af-r3-gate-probe-a.md', 'About the 99-af-e2e fixture area (A)');
  const taskB = mk('TASK-REAL-GOV-B', '99-af-e2e/af-r3-gate-probe-b.md', 'About the 99-af-e2e fixture area (B)');

  const scheduler = new Scheduler({ maxConcurrent: 2, adapters: (await import('../lib/adapters.mjs')).ADAPTERS });
  scheduler.enqueue(taskA);
  scheduler.enqueue(taskB);
  scheduler.runNext();
  await scheduler.waitAll();

  const a = JSON.parse(readFileSync(join(ROOT, 'tasks', 'TASK-REAL-GOV-A.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(ROOT, 'tasks', 'TASK-REAL-GOV-B.json'), 'utf8'));
  const candA = a.governance?.candidate_id ?? null;
  const candB = b.governance?.candidate_id ?? null;

  // candidate correlation from the vault (hermetic fixture state.db = truth)
  let dbCorrelation = null;
  try {
    dbCorrelation = execSync(`node --experimental-sqlite -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/tmp/af-gov-vault/state.db");
const rows = db.prepare("SELECT candidate_id, task_id, author_agent_instance_id, mode FROM candidates WHERE task_id LIKE ?").all("TASK-REAL-GOV%");
console.log(JSON.stringify(rows));'`, { encoding: 'utf8' });
  } catch (e) { dbCorrelation = `check_error: ${String(e.message).slice(0, 120)}`; }

  const report = {
    test: 'R3',
    state_A: a.state, state_B: b.state,
    candidate_A: candA, candidate_B: candB,
    candidates_distinct: !!candA && !!candB && candA !== candB,
    reviewer_identity_A: a.governance?.agent_instance_ids?.reviewer ?? null,
    reviewer_identity_B: b.governance?.agent_instance_ids?.reviewer ?? null,
    reviewer_identities_distinct: (a.governance?.agent_instance_ids?.reviewer !== b.governance?.agent_instance_ids?.reviewer),
    policy_A: a.governance?.policy_decision ?? null,
    policy_B: b.governance?.policy_decision ?? null,
    fixture_db_correlation: (() => { try { return JSON.parse(dbCorrelation); } catch { return dbCorrelation; } })(),
    failure_reasons: [a.failure_reason, b.failure_reason].filter(Boolean),
  };
  const bothWaitingOrTerminal = ['WAITING_HUMAN', 'COMPLETED'].includes(a.state) && ['WAITING_HUMAN', 'COMPLETED'].includes(b.state);
  const pass = bothWaitingOrTerminal && report.candidates_distinct && report.reviewer_identities_distinct;
  console.log(JSON.stringify(report, null, 1));
  if (!pass) { console.error('R3: FAIL'); process.exit(1); }
  console.error('R3: PASS');
}

const which = process.argv[2];
const runner = { R1: runR1, R2: runR2, R3: runR3 }[which];
if (!runner) { console.error('usage: node tests/real-host-verify.mjs R1|R2|R3'); process.exit(2); }
runner()
  .then(() => {
    if (process.argv[2] === 'R3' || process.argv[2] === 'R2') {
      console.error('--- real vault zero touch ---');
      console.log(JSON.stringify(realVaultTouchCheck(), null, 1));
    }
  })
  .catch((e) => { console.error('FATAL:', e?.message ?? e); process.exit(1); });
