// tests/helpers/tasks-dir-fixture.mjs
//
// A test that drives executeTask/Scheduler without passing an explicit tasksDir
// used to write its task files straight into the repository's tasks/ directory,
// which is why that directory accumulated a hundred-odd leftover task files.
// Point the default at a temporary directory instead.
//
// AF_TASKS_DIR is read when the modules load, so import this BEFORE anything
// that pulls in orchestrator.mjs or lib/scheduler.mjs. An explicitly configured
// value always wins.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TASKS_DIR = mkdtempSync(join(tmpdir(), 'af-tasks-'));

if (!process.env.AF_TASKS_DIR) {
  process.env.AF_TASKS_DIR = TEST_TASKS_DIR;
}
