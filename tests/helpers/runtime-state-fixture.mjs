// tests/helpers/runtime-state-fixture.mjs
//
// The runtime safety state and the runtime event log are per-instance files
// that live in runtime/. A test that executes a real adapter would otherwise
// write circuit-breaker state and audit events straight into the checkout.
//
// Point the default guard at temporary files instead. Import this BEFORE
// anything that transitively loads lib/adapters.mjs or
// lib/executor-runtime-guard.mjs - the default paths are resolved once, at
// module load. An explicit AF_SAFETY_STATE_FILE / AF_RUNTIME_EVENTS_LOG always
// wins.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_STATE_DIR = mkdtempSync(join(tmpdir(), 'af-runtime-state-'));

export const SAFETY_STATE_FILE = join(RUNTIME_STATE_DIR, 'executor-safety-state.json');
export const RUNTIME_EVENTS_LOG = join(RUNTIME_STATE_DIR, 'executor-runtime-events.jsonl');

process.env.AF_SAFETY_STATE_FILE ??= SAFETY_STATE_FILE;
process.env.AF_RUNTIME_EVENTS_LOG ??= RUNTIME_EVENTS_LOG;
