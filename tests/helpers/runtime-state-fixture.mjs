// tests/helpers/runtime-state-fixture.mjs
//
// The runtime safety state, the audit log, the run handles, the scheduler's
// per-instance metadata and the locks are all PER-INSTANCE files under
// runtime/ and locks/. A test that executes an adapter or a Scheduler would
// otherwise write them straight into the checkout, which is how runtime/ used
// to accumulate test residue (gitignored, so `git status` stayed clean and it
// went unnoticed).
//
// Point the whole group at one temporary sandbox. Import this BEFORE anything
// that loads lib/config.mjs - the paths are resolved once, at module load. An
// explicitly configured variable always wins, as does a finer-grained one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RUNTIME_SANDBOX = mkdtempSync(join(tmpdir(), 'af-runtime-'));
export const SAFETY_STATE_FILE = join(RUNTIME_SANDBOX, 'executor-safety-state.json');
export const RUNTIME_EVENTS_LOG = join(RUNTIME_SANDBOX, 'executor-runtime-events.jsonl');

process.env.AF_RUNTIME_DIR ??= RUNTIME_SANDBOX;
process.env.AF_LOCKS_DIR ??= join(RUNTIME_SANDBOX, 'locks');
process.env.AF_RUNS_DIR ??= join(RUNTIME_SANDBOX, 'runs');
process.env.AF_SAFETY_STATE_FILE ??= SAFETY_STATE_FILE;
process.env.AF_RUNTIME_EVENTS_LOG ??= RUNTIME_EVENTS_LOG;
