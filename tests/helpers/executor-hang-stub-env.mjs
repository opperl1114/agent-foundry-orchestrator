// tests/helpers/executor-hang-stub-env.mjs
//
// The claude and antigravity adapters resolve their launcher ONCE, when
// lib/config.mjs is evaluated - unlike the vertex and cline adapters, which
// re-read the env at call time. Pointing them at a stub therefore has to happen
// from a module that is evaluated BEFORE lib/adapters.mjs is imported. codex is
// spawned by name, so it needs a PATH shim instead.
//
// The stubs start and stay alive, which is what the cancellation tests need.

import {
  rmSync, chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const HANGING_SOURCE = `#!/usr/bin/env node
setInterval(() => {}, 1000);
`;

const STUB_BIN_DIR = mkdtempSync(join(tmpdir(), 'af-test-executor-hang-'));

function writeHangingStub(fileName) {
  const file = join(STUB_BIN_DIR, fileName);
  writeFileSync(file, HANGING_SOURCE, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

export const CLAUDE_HANGING_STUB = writeHangingStub('claude-af-stub');

// A sandbox that outlives the process is its own kind of residue: these are
// created once per test FILE per run, so without this they accumulate in /tmp.
process.on('exit', () => {
  try { rmSync(STUB_BIN_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

export const AGY_HANGING_STUB = writeHangingStub('agy-af-stub');
// codex is spawned by name, so the shim must be called exactly "codex".
export const CODEX_HANGING_STUB = writeHangingStub('codex');
export const STUB_BIN_DIR_PATH = STUB_BIN_DIR;

process.env.CLAUDE_LAUNCHER ??= CLAUDE_HANGING_STUB;
process.env.AGY_LAUNCHER ??= AGY_HANGING_STUB;
process.env.PATH = `${STUB_BIN_DIR}${delimiter}${process.env.PATH ?? ''}`;
