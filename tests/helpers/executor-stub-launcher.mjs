// tests/helpers/executor-stub-launcher.mjs
//
// 6A-* and CLINE-7 exercise the ADAPTER contract (the unified ExecutorResult
// shape, exact resume, cancel evidence, and the reasoning-effort arguments the
// adapter builds). Asserting any of that against a real provider CLI makes the
// suite depend on that CLI being installed and signed in, which is exactly the
// kind of author-machine dependency the tests are supposed to avoid - and
// probing `cline --help` for "--thinking xhigh" tested the vendor CLI, not the
// adapter.
//
// These stub launchers satisfy the launcher protocol the adapters already
// speak: emit one JSON envelope on stdout (vertex) that is also a valid
// run_result line (cline), and stay alive when the prompt is __AF_HANG__ so
// cancellation can be exercised against a real process.
//
// The adapters read process.env.VERTEX_GEMINI_LAUNCHER / CLINE_LAUNCHER at call
// time, so a test can point them at a stub for a single case.

import {
  rmSync, chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const STUB_DIR = mkdtempSync(join(tmpdir(), 'af-executor-stub-'));

// A sandbox that outlives the process is its own kind of residue: these are
// created once per test FILE per run, so without this they accumulate in /tmp.
process.on('exit', () => {
  try { rmSync(STUB_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

export const STUB_ARGV_LOG = join(STUB_DIR, 'argv.log');

const STUB_SOURCE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (process.env.AF_STUB_ARGV_LOG) {
  appendFileSync(process.env.AF_STUB_ARGV_LOG, JSON.stringify(args) + '\\n');
}

if (args.includes('__AF_HANG__')) {
  setInterval(() => {}, 1000);
} else {
  let session = 'SES-FIXTURE';
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '--resume' || args[i] === '--id') && args[i + 1]) session = args[i + 1];
  }
  const envelope = {
    taskId: session,
    session_id: session,
    type: 'run_result',
    finishReason: 'completed',
    is_error: false,
    result: 'fixture executor result',
    text: 'fixture executor result',
    structured_output: {
      decision: 'PASS',
      summary: 'fixture review',
      issues: [],
      required_changes: [],
      evidence: ['fixture'],
    },
  };
  process.stdout.write(JSON.stringify(envelope) + '\\n');
}
`;

const POLICY_DENIAL_SOURCE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (process.env.AF_STUB_ARGV_LOG) {
  appendFileSync(process.env.AF_STUB_ARGV_LOG, JSON.stringify(args) + '\\n');
}

// JSON Lines on stdout with an EMPTY stderr, the way codex --json reports a
// refusal: an account/ToS denial only ever shows up on stdout.
process.stdout.write(JSON.stringify({
  type: 'error',
  message: 'unexpected status 403 Forbidden: account suspended for Terms of Service violation',
}) + '\\n');
process.exitCode = 1;
`;

const RATE_LIMIT_SOURCE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (process.env.AF_STUB_ARGV_LOG) {
  appendFileSync(process.env.AF_STUB_ARGV_LOG, JSON.stringify(args) + '\\n');
}

// A provider quota refusal, which the classifier maps to RATE_LIMIT/COOLDOWN.
process.stderr.write('Daily limit reached for model z-ai/glm-5.3-flash\\n');
process.exitCode = 1;
`;

function writeStub(fileName, source = STUB_SOURCE) {
  const file = join(STUB_DIR, fileName);
  writeFileSync(file, source, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

// The cline adapter's health() reports the launcher path, and CLINE-2 asserts
// it points at the cline-af adapter, so the stub keeps that name.
export const CLINE_STUB = writeStub('cline-af-stub');
export const VERTEX_STUB = writeStub('vertex-gemini-af-stub');

// Stub that reports an account/ToS refusal on stdout and exits non-zero.
export const POLICY_DENIAL_STUB = writeStub('cline-af-policy-denial', POLICY_DENIAL_SOURCE);

// Stub that reports a provider quota refusal (RATE_LIMIT) and exits non-zero.
export const RATE_LIMIT_STUB = writeStub('cline-af-rate-limit', RATE_LIMIT_SOURCE);
