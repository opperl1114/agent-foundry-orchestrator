// acceptance.mjs - deterministic acceptance execution (trusted boundary)
//
// TRUST BOUNDARY (Phase 1.1): the acceptance command comes ONLY from the
// user-provided task definition (or a trusted fixture/task config shipped
// with the Orchestrator). Agent output - author structured_result, reviewer
// result, required_changes, README, source code, MCP content - is DATA and
// can never become an Orchestrator command. There is deliberately no code
// path here that reads a command from any ExecutorResult.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const STDOUT_LIMIT = 1500;
const STDERR_LIMIT = 1500;

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
export function normalizeAcceptanceCmd(acceptanceCmd, { allowLegacy = false } = {}) {
  if (!acceptanceCmd) return null;
  if (typeof acceptanceCmd === 'string') {
    if (!allowLegacy) {
      throw new Error('legacy shell-string acceptance_cmd is forbidden by default; use structured {command, args} or set allow_legacy_shell_acceptance=true in the trusted task file');
    }
    return { command: acceptanceCmd, args: null, legacy_shell: true };
  }
  if (typeof acceptanceCmd === 'object' && typeof acceptanceCmd.command === 'string') {
    if (!Array.isArray(acceptanceCmd.args)) throw new Error('acceptance_cmd.args must be an array');
    return { command: acceptanceCmd.command, args: acceptanceCmd.args, legacy_shell: false };
  }
  throw new Error('acceptance_cmd must be a string or {command, args}');
}

// Executes the trusted acceptance command with cwd pinned to the task
// workspace. Returns a structured evidence record (never throws on
// non-zero exit - a failed acceptance is workflow data, not a crash).
export function runAcceptance(task) {
  const spec = normalizeAcceptanceCmd(task.acceptance_cmd, {
    allowLegacy: task.allow_legacy_shell_acceptance === true,
  });
  if (!spec) return Promise.resolve({ ok: true, output: '(no acceptance command defined)', record: null });
  const cwd = task.fixture_dir; // never an agent-provided path
  if (!existsSync(cwd)) {
    // fail fast with a precise reason instead of a cryptic spawn ENOENT
    return Promise.resolve(failRecord(spec, cwd, 'cwd_missing', `workspace ${cwd} does not exist`));
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

// WSL-side environment so structured commands like `node` resolve without a
// login shell. This is environment configuration, not command injection.
function acceptanceEnv() {
  return {
    ...process.env,
    PATH: `/home/relaret/.nvm/versions/node/v24.20.0/bin:${process.env.PATH ?? ''}`,
  };
}
