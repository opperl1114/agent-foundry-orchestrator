// acceptance.mjs - deterministic acceptance execution (trusted boundary)
//
// TRUST BOUNDARY (Phase 1.1): the acceptance command comes ONLY from the
// user-provided task definition (or a trusted fixture/task config shipped
// with the Orchestrator). Agent output - author structured_result, reviewer
// result, required_changes, README, source code, MCP content - is DATA and
// can never become an Orchestrator command. There is deliberately no code
// path here that reads a command from any ExecutorResult.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ALLOWLIST_FILE = join(ROOT_DIR, 'config', 'acceptance-allowlist.json');

const STDOUT_LIMIT = 1500;
const STDERR_LIMIT = 1500;

// An acceptance command that never finishes must not wedge the task forever.
const ACCEPTANCE_TIMEOUT_DEFAULT = 10 * 60_000;
const ACCEPTANCE_KILL_GRACE_MS = 4000;

// Live acceptance children, so the shutdown path can reclaim them (it only knew
// about executor runs before).
const activeAcceptances = new Map(); // pid -> child

// The acceptance command is a trust anchor: it is executed with the operator's
// privileges. A task may only run a command the allowlist names, and only with
// the argument prefix it names. A missing or unreadable allowlist denies
// everything (fail-closed) rather than falling back to "anything goes".
export function loadAcceptanceAllowlist(file = process.env.AF_ACCEPTANCE_ALLOWLIST || DEFAULT_ALLOWLIST_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed?.allowed)) return [];
  return parsed.allowed
    .filter((entry) => entry && typeof entry.command === 'string')
    .map((entry) => ({
      command: entry.command,
      args_prefix: Array.isArray(entry.args_prefix) ? entry.args_prefix.map(String) : [],
    }));
}

function isAllowed(spec, allowlist) {
  if (spec.legacy_shell) return false; // the legacy shell string is closed; see normalizeAcceptanceCmd
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const command = String(spec.command);
  // The command is matched EXACTLY against an allowlist entry. Matching on the
  // basename instead let any file that merely shared a name through - a task
  // naming /tmp/somewhere/node was authorized by the "node" entry. An entry may
  // name a bare program (resolved through PATH) or an explicit path; either way
  // the task has to name that same thing.
  return allowlist.some((entry) => {
    if (String(entry.command) !== command) return false;
    return entry.args_prefix.every((expected, i) => args[i] === expected);
  });
}

function realOrResolved(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

// The control plane (tasks/, runtime/, locks/, config/) lives under the
// orchestrator root. An executor workspace must never be able to reach it.
function isInsideOrchestratorRoot(dir) {
  if (!dir) return false;
  const root = realOrResolved(ROOT_DIR);
  const target = realOrResolved(dir);
  return target === root || target.startsWith(`${root}/`);
}

// Binds the acceptance trust anchor to a digest. The task file is rewritten
// constantly as a task runs, so hashing the whole file would trip on every
// state change; what must not change silently is the command that will be
// executed and the legacy flag that widens it.
//
// fixture_dir is deliberately NOT part of the digest: the control plane fills
// in a default for a task that did not declare one, so it is not a stable
// declared value. Where the command may run is enforced separately (the
// workspace must not be inside the orchestrator root).
export function acceptanceBinding(task = {}) {
  const anchor = {
    acceptance_cmd: task.acceptance_cmd ?? null,
    allow_legacy_shell_acceptance: task.allow_legacy_shell_acceptance === true,
  };
  return createHash('sha256').update(JSON.stringify(anchor)).digest('hex');
}

export function verifyAcceptanceBinding(task = {}) {
  // A MISSING binding is not "unbound and therefore fine": the field exists
  // precisely to detect a task file edited after validation, so deleting it
  // must fail closed. The scheduler re-bound whatever it found on read
  // (`?? acceptanceBinding(...)`), which turned "delete the field" into a
  // one-step bypass of the whole anchor.
  if (!task.acceptance_binding) {
    return { ok: false, bound: false, reason: 'acceptance_binding missing (the trust anchor was unbound)' };
  }
  const actual = acceptanceBinding(task);
  if (actual !== task.acceptance_binding) {
    return { ok: false, bound: true, expected: task.acceptance_binding, actual };
  }
  return { ok: true, bound: true };
}

function failRecord(spec, cwd, reason, extraErr) {
  return {
    ok: false,
    output: `acceptance environment error: ${reason}`,
    record: {
      command: spec.command, args: spec.args, cwd, legacy_shell: spec.legacy_shell,
      exit_code: -1, duration_ms: 0, started_at: new Date().toISOString(),
      stdout_summary: '', stderr_summary: extraErr ?? '',
      failure_reason: reason,
    },
  };
}

function truncate(s, limit) {
  if (!s) return '';
  return s.length > limit ? `${s.slice(0, limit)}…(truncated ${s.length - limit} chars)` : s;
}

// Normalizes task.acceptance_cmd to {command, args, legacy_shell} or null.
// Structured form (required by default): {command: "node", args: ["--test"]}
//
// The legacy shell-string form is CLOSED. It used to be gated only by the task
// file's allow_legacy_shell_acceptance flag, and the branch returned before any
// whitelist check - so a task file holding that flag plus a string could run an
// arbitrary shell, while the README states the command must match the whitelist.
// Routing it through isAllowed (which rejects legacy_shell outright) closes the
// channel and makes that claim true. It can never be enabled by agent output.
export function normalizeAcceptanceCmd(acceptanceCmd, { allowLegacy = false, allowlist = null } = {}) {
  if (!acceptanceCmd) return null;
  if (typeof acceptanceCmd === 'string') {
    if (!allowLegacy) {
      throw new Error('legacy shell-string acceptance_cmd is forbidden; use structured {command, args}');
    }
    const spec = { command: acceptanceCmd, args: null, legacy_shell: true };
    if (!isAllowed(spec, allowlist ?? loadAcceptanceAllowlist())) {
      throw new Error(`acceptance_command_not_allowlisted: ${acceptanceCmd}`);
    }
    return spec;
  }
  if (typeof acceptanceCmd === 'object' && typeof acceptanceCmd.command === 'string') {
    if (!Array.isArray(acceptanceCmd.args)) throw new Error('acceptance_cmd.args must be an array');
    const spec = { command: acceptanceCmd.command, args: acceptanceCmd.args, legacy_shell: false };
    if (!isAllowed(spec, allowlist ?? loadAcceptanceAllowlist())) {
      throw new Error(`acceptance_command_not_allowlisted: ${spec.command} ${spec.args.join(' ')}`.trim());
    }
    return spec;
  }
  throw new Error('acceptance_cmd must be a string or {command, args}');
}

// Executes the trusted acceptance command with cwd pinned to the task
// workspace. Returns a structured evidence record (never throws on
// non-zero exit - a failed acceptance is workflow data, not a crash).
export function runAcceptance(task) {
  // Rejected trust anchors are workflow failures, never crashes: the caller
  // records them as evidence and fails the task closed.
  const binding = verifyAcceptanceBinding(task);
  if (!binding.ok) {
    return Promise.resolve(failRecord(
      { command: '(unverified)', args: null, legacy_shell: false },
      task.fixture_dir ?? '',
      'TASK_FILE_TAMPERED',
      `the acceptance trust anchor changed after task creation (expected ${binding.expected}, got ${binding.actual})`
    ));
  }

  let spec;
  try {
    spec = normalizeAcceptanceCmd(task.acceptance_cmd, {
      allowLegacy: task.allow_legacy_shell_acceptance === true,
    });
  } catch (err) {
    return Promise.resolve(failRecord(
      { command: '(rejected)', args: null, legacy_shell: false },
      task.fixture_dir ?? '',
      'ACCEPTANCE_COMMAND_REJECTED',
      String(err?.message ?? err)
    ));
  }
  if (!spec) return Promise.resolve({ ok: true, output: '(no acceptance command defined)', record: null });
  const cwd = task.fixture_dir; // never an agent-provided path
  if (!existsSync(cwd)) {
    // fail fast with a precise reason instead of a cryptic spawn ENOENT
    return Promise.resolve(failRecord(spec, cwd, 'cwd_missing', `workspace ${cwd} does not exist`));
  }
  if (isInsideOrchestratorRoot(cwd)) {
    // An executor with write tools must not be able to reach the control plane
    // (tasks/, runtime/, locks/) through its workspace.
    return Promise.resolve(failRecord(spec, cwd, 'FIXTURE_DIR_INSIDE_ORCHESTRATOR', `workspace ${cwd} is inside the orchestrator root ${ROOT_DIR}`));
  }
  const started = new Date().toISOString();
  const t0 = Date.now();
  const timeoutMs = Number(task.acceptance_timeout_ms ?? ACCEPTANCE_TIMEOUT_DEFAULT);

  return new Promise((resolve) => {
    const child = spec.legacy_shell
      ? spawn('bash', ['-lc', spec.command], { cwd, env: acceptanceEnv() })
      : spawn(spec.command, spec.args, { cwd, env: acceptanceEnv() });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let escalation = null;

    const release = () => {
      if (child.pid !== undefined) activeAcceptances.delete(child.pid);
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
    };
    const settle = (result) => {
      if (settled) return; // 'error' and 'close' can both fire
      settled = true;
      release();
      resolve(result);
    };

    // Timeout: SIGTERM, then SIGKILL after a grace period. The failure is still
    // recorded as workflow data (a structured record), never thrown.
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* already gone */ }
          escalation = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
          }, ACCEPTANCE_KILL_GRACE_MS);
          escalation.unref?.();
        }, timeoutMs)
      : null;
    timer?.unref?.();

    if (child.pid !== undefined) activeAcceptances.set(child.pid, child);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      settle({
        ok: false,
        output: truncate(`${stdout}\n${stderr}`, STDOUT_LIMIT),
        record: {
          command: spec.command, args: spec.args, cwd, legacy_shell: spec.legacy_shell,
          exit_code: -1, duration_ms: Date.now() - t0, started_at: started,
          stdout_summary: truncate(stdout, STDOUT_LIMIT), stderr_summary: truncate(`${stderr}\n${String(e)}`, STDERR_LIMIT),
          failure_reason: 'spawn_error',
        },
      });
    });
    child.on('close', (code) => {
      settle({
        ok: !timedOut && code === 0,
        output: truncate(`${stdout}\n${stderr}`, STDOUT_LIMIT + STDERR_LIMIT),
        record: {
          command: spec.command, args: spec.args, cwd, legacy_shell: spec.legacy_shell,
          exit_code: timedOut ? null : code, duration_ms: Date.now() - t0, started_at: started,
          stdout_summary: truncate(stdout, STDOUT_LIMIT), stderr_summary: truncate(stderr, STDERR_LIMIT),
          failure_reason: timedOut ? 'timeout' : (code === 0 ? null : `exit ${code}`),
        },
      });
    });
  });
}

// Reclaim live acceptance children (the shutdown path calls this next to
// terminateAllActiveRuns). Without it a SIGTERM left an acceptance child orphaned
// - the invariant the shutdown tests assert only ever covered executor runs.
export function terminateActiveAcceptances({ signal = 'SIGTERM' } = {}) {
  const children = [...activeAcceptances.values()];
  for (const child of children) {
    try { child.kill(signal); } catch { /* already gone */ }
  }
  return { requested: children.length };
}

import { CURRENT_NODE_BIN_DIR } from './config.mjs';

// The acceptance child is handed an explicit environment, never the whole
// parent environment: it runs a command derived from a task definition, so
// credentials that happen to be exported in the operator's shell must not be
// reachable from it.
const ACCEPTANCE_ENV_ALLOW = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LANGUAGE', 'TZ',
  'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'SHELL', 'TERM',
];

function acceptanceEnv() {
  const env = {};
  for (const key of ACCEPTANCE_ENV_ALLOW) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Explicit opt-in passthrough for anything else the operator wants to expose.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AF_ACCEPTANCE_ENV_')) {
      env[key.slice('AF_ACCEPTANCE_ENV_'.length)] = value;
    }
  }
  env.PATH = `${CURRENT_NODE_BIN_DIR}:${env.PATH ?? ''}`;
  return env;
}
