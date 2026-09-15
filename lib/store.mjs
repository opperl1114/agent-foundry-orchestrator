// store.mjs - atomic task store (Control Plane truth)
// Any reader sees either the previous complete JSON or the new complete JSON.
// Same-filesystem rename; no database introduced (Phase 1.1 boundary).

import { writeFileSync, renameSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readTaskFile(taskFile) {
  return JSON.parse(readFileSync(taskFile, 'utf8'));
}

export function taskFileExists(taskFile) {
  return existsSync(taskFile);
}

// Atomic write: tmp file in the SAME directory, then rename over the target.
// failMode is a test hook (Phase 1.1 TEST D); production callers omit it.
export function saveTaskAtomic(taskFile, task, { fail = null } = {}) {
  const dir = dirname(taskFile);
  const tmp = join(dir, `.${task.task_id || 'task'}.json.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  try {
    if (fail === 'write') throw new Error('injected write failure');
    writeFileSync(tmp, JSON.stringify(task, null, 2));
    if (fail === 'rename') throw new Error('injected rename failure');
    renameSync(tmp, taskFile);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}
