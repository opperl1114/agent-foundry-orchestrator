// tasklock.mjs - PHASE 3 minimal task lock (Control Plane ownership)
//
// One task has at most one active Control Plane owner at a time. The lock is
// an atomic file create (flag 'wx') at locks/<task_id>.lock containing:
//   task_id, orchestrator_instance_id, pid, acquired_at, lease_expires_at
// A SECOND run/resume hitting a VALID lock is rejected (TASK_ALREADY_RUNNING).
// A STALE lock (owner pid gone, lease expired, or corrupt file) is recovered -
// never silently deleted: the recovery is recorded and returned to the caller
// so it can be logged as stale_lock_recovered=true.
// This is a Control Plane lock only. It is NOT the formal vault-mcp writer
// lock, which stays entirely inside the Governance Plane.

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class LockHeldError extends Error {
  constructor(taskId, lock) {
    super(`TASK_ALREADY_RUNNING: task ${taskId} has a valid lock held by orchestrator ${lock?.orchestrator_instance_id ?? '?'} (pid ${lock?.pid ?? '?'}, acquired ${lock?.acquired_at ?? '?'})`);
    this.code = 'TASK_ALREADY_RUNNING';
    this.task_id = taskId;
    this.lock = lock;
  }
}

export function lockPath(locksDir, taskId) {
  return join(locksDir, `${taskId}.lock`);
}

export function readLock(locksDir, taskId) {
  try {
    return JSON.parse(readFileSync(lockPath(locksDir, taskId), 'utf8'));
  } catch {
    return null; // missing or corrupt -> treated by isLockStale
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists but owned by another user -> alive
  }
}

export function isLockStale(lock, now = Date.now()) {
  if (!lock || typeof lock !== 'object') return true; // no/corrupt lock -> stale
  if (lock.lease_expires_at !== undefined && lock.lease_expires_at !== null) {
    const expires = Date.parse(lock.lease_expires_at);
    // A malformed lease cannot be trusted to be in the future: treating it as
    // valid would pin the task behind a lock nobody can ever renew.
    if (Number.isNaN(expires)) return true;
    if (expires < now) return true;
  }
  if (typeof lock.pid === 'number' && !pidAlive(lock.pid)) return true;
  return false;
}

// Atomic acquire. On an existing STALE lock: unlink it, record the recovery
// (returned as recovered_from, plus stale_lock_recovered=true) and create our
// own. On a VALID lock: throw LockHeldError (TASK_ALREADY_RUNNING).
export function acquireTaskLock(locksDir, taskId, { orchestratorInstanceId, pid = process.pid, leaseMs = 15 * 60_000 } = {}) {
  if (!orchestratorInstanceId) throw new Error('acquireTaskLock requires orchestratorInstanceId');
  mkdirSync(locksDir, { recursive: true });
  const now = new Date();
  const makeLock = () => ({
    task_id: taskId,
    orchestrator_instance_id: orchestratorInstanceId,
    pid,
    acquired_at: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
  });
  let recovered = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const lock = makeLock();
      writeFileSync(lockPath(locksDir, taskId), JSON.stringify(lock, null, 2), { flag: 'wx' });
      return { lock, stale_lock_recovered: recovered !== null, recovered_from: recovered };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existing = readLock(locksDir, taskId);
      if (!isLockStale(existing)) throw new LockHeldError(taskId, existing);
      // stale: record what we are recovering from, then try to take over.
      recovered = {
        stale_lock_recovered: true,
        previous_pid: existing?.pid ?? null,
        previous_orchestrator_instance_id: existing?.orchestrator_instance_id ?? null,
        previous_acquired_at: existing?.acquired_at ?? null,
        stale_reason: existing
          ? (existing.lease_expires_at && Date.parse(existing.lease_expires_at) < Date.now() ? 'lease_expired' : 'owner_pid_not_alive')
          : 'corrupt_lock_file',
      };
      try { unlinkSync(lockPath(locksDir, taskId)); } catch { /* someone else removed it */ }
    }
  }
  throw new LockHeldError(taskId, readLock(locksDir, taskId));
}

export function renewTaskLock(locksDir, taskId, lock, leaseMs = 15 * 60_000) {
  // heartbeat: extend our own lease (only the owner may renew). The renewal is
  // an atomic replace with an owner re-check immediately before the rename, so
  // a lock that changed hands mid-renewal is never overwritten.
  const path = lockPath(locksDir, taskId);
  const current = readLock(locksDir, taskId);
  if (!current || current.orchestrator_instance_id !== lock.orchestrator_instance_id) {
    throw new Error(`lock for ${taskId} is no longer owned by this orchestrator instance`);
  }
  const next = { ...current, lease_expires_at: new Date(Date.now() + leaseMs).toISOString() };
  const tmp = `${path}.renew-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  const guard = readLock(locksDir, taskId);
  if (!guard || guard.orchestrator_instance_id !== lock.orchestrator_instance_id) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw new Error(`lock for ${taskId} was taken over during renewal`);
  }
  renameSync(tmp, path);
  return next;
}

export function releaseTaskLock(locksDir, taskId, lock) {
  // never delete a lock we do not own (owner identity check, not blind rm)
  const current = readLock(locksDir, taskId);
  if (!current) return true;
  if (lock && current.orchestrator_instance_id !== lock.orchestrator_instance_id) return false;
  try { unlinkSync(lockPath(locksDir, taskId)); return true; } catch { return true; }
}
