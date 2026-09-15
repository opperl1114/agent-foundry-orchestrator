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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ALLOWLIST_FILE = join(ROOT_DIR, 'config', 'acceptance-allowlist.json');

const STDOUT_LIMIT = 1500;
const STDERR_LIMIT = 1500;

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
  if (spec.legacy_shell) return false; // never allowlisted by prefix
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  // A command may be listed more than once with different argument prefixes;
  // ANY matching entry authorizes it.
  return allowlist.some((entry) => {
    if (entry.command !== basename(spec.command)) return false;
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
  if (!task.acceptance_binding) return { ok: true, bound: false };
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
// Legacy string form is FORBIDDEN by default (Phase 1.1 closure): it may only
// be enabled explicitly by the trusted task file via
// allow_legacy_shell_acceptance=true. It can never be enabled by agent output.
//
// The structured form must additionally match config/acceptance-allowlist.json
// (or AF_ACCEPTANCE_ALLOWLIST): the acceptance command is a trust anchor and a
// task definition must not be able to run an arbitrary program.
export function normalizeAcceptanceCmd(acceptanceCmd, { allowLegacy = false, allowlist = null } = {}) {
  if (!acceptanceCmd) return null;
  if (typeof acceptanceCmd === 'string') {
    if (!allowLegacy) {
      throw new Error('legacy shell-string acceptance_cmd is forbidden by default; use structured {command, args} or set allow_legacy_shell_acceptance=true in the trusted task file');
    }
    return { command: acceptanceCmd, args: null, legacy_shell: true };
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
  return new Promise((resolve) => {
    const child = spec.legacy_shell
      ? spawn('bash', ['-lc', spec.command], { cwd, env: acceptanceEnv() })
      : spawn(spec.command, spec.args, { cwd, env: acceptanceEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      resolve({
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
      resolve({
        ok: code === 0,
        output: truncate(`${stdout}\n${stderr}`, STDOUT_LIMIT + STDERR_LIMIT),
        record: {
          command: spec.command, args: spec.args, cwd, legacy_shell: spec.legacy_shell,
          exit_code: code, duration_ms: Date.now() - t0, started_at: started,
          stdout_summary: truncate(stdout, STDOUT_LIMIT), stderr_summary: truncate(stderr, STDERR_LIMIT),
          failure_reason: code === 0 ? null : `exit ${code}`,
        },
      });
    });
  });
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
