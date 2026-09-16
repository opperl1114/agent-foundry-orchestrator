// lib/worktree.mjs - Git Worktree Isolation & Parallel Execution Manager
//
// Invariants:
//   1. Physical Workspace Isolation: Each parallel worker writes to a dedicated git worktree.
//   2. Single Active Writer per target: One active writer per worktree directory.
//   3. Deterministic Merge: Completed step branches are merged into the integration branch.
//   4. Conflict Detection: Conflicting edits are detected fail-closed; no silent overwrites or last-write-wins.
//   5. Hermetic Cleanup: Temporary worktrees and branches are cleanly pruned after completion or cancellation.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const message = err.stderr ? err.stderr.trim() : err.message;
    const error = new Error(`git ${args.join(' ')} failed in ${cwd}: ${message}`);
    error.code = err.status ?? 'GIT_ERROR';
    error.stderr = err.stderr ? err.stderr.trim() : '';
    error.stdout = err.stdout ? err.stdout.trim() : '';
    throw error;
  }
}

export function isGitRepo(dir) {
  try {
    const res = git(['rev-parse', '--is-inside-work-tree'], dir);
    return res === 'true';
  } catch {
    return false;
  }
}

export function getGitRoot(dir) {
  try {
    return git(['rev-parse', '--show-toplevel'], dir);
  } catch {
    return null;
  }
}

export function getCurrentBranch(dir) {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  } catch {
    return 'main';
  }
}

// Commits need an identity. Use the repository/user's own when it is configured,
// and only fall back to a synthetic one (passed per command, never written to
// the repository config) when there is none - a bare CI container has no git
// identity at all.
function commitIdentityArgs(dir) {
  try {
    const email = git(['config', 'user.email'], dir);
    if (email) return [];
  } catch { /* no identity configured */ }
  return ['-c', 'user.name=Agent Foundry', '-c', 'user.email=agent-foundry@local'];
}

export function ensureGitRepo(dir, { defaultBranch = 'main', user = 'Agent Foundry', email = 'agent-foundry@local', initIfMissing = false } = {}) {
  // Initialising a repository inside a directory that was never one is opt-in:
  // this used to silently `git init` in whatever directory it was given. The
  // commit identity is passed per command (-c) instead of being written into the
  // repository's config, so a user's own settings are never rewritten.
  const identity = ['-c', `user.name=${user}`, '-c', `user.email=${email}`];
  const baseline = ['commit', '--allow-empty', '-m', 'chore: initial baseline commit for worktree isolation'];

  if (!isGitRepo(dir)) {
    if (!initIfMissing) {
      const err = new Error(`NOT_A_GIT_REPO: ${dir} is not a git repository (pass { initIfMissing: true } to initialise one)`);
      err.code = 'NOT_A_GIT_REPO';
      throw err;
    }
    mkdirSync(dir, { recursive: true });
    git(['init', '-b', defaultBranch], dir);
    git([...identity, ...baseline], dir);
    return dir;
  }

  mkdirSync(dir, { recursive: true });
  try {
    git(['rev-parse', 'HEAD'], dir);
  } catch {
    // Repo exists but has no commits yet: create the baseline.
    git([...identity, ...baseline], dir);
  }
  return dir;
}

export function createWorktree({ repoDir, branch, worktreeDir, baseRef = 'HEAD' }) {
  if (!isGitRepo(repoDir)) {
    throw new Error(`Cannot create worktree: ${repoDir} is not a git repository`);
  }

  const absWorktreeDir = resolve(worktreeDir);
  mkdirSync(resolve(absWorktreeDir, '..'), { recursive: true });

  // If worktree dir already exists, remove it first
  if (existsSync(absWorktreeDir)) {
    try {
      git(['worktree', 'remove', '--force', absWorktreeDir], repoDir);
    } catch {
      rmSync(absWorktreeDir, { recursive: true, force: true });
    }
  }

  // Delete existing branch if it already exists
  try {
    git(['branch', '-D', branch], repoDir);
  } catch {
    // Branch may not exist yet, ignore
  }

  git(['worktree', 'add', '-b', branch, absWorktreeDir, baseRef], repoDir);

  return {
    repoDir,
    branch,
    worktreeDir: absWorktreeDir,
    baseRef,
  };
}

export function commitWorktree({ worktreeDir, message = 'chore: auto commit from worktree step', allowEmpty = true }) {
  if (!isGitRepo(worktreeDir)) {
    throw new Error(`Cannot commit: ${worktreeDir} is not a git repository`);
  }

  git(['add', '-A'], worktreeDir);
  const status = git(['status', '--porcelain'], worktreeDir);
  const identity = commitIdentityArgs(worktreeDir);
  if (!status) {
    if (allowEmpty) {
      git([...identity, 'commit', '--allow-empty', '-m', message], worktreeDir);
      const commitHash = git(['rev-parse', 'HEAD'], worktreeDir);
      return { commitHash, clean: true, committed: true };
    }
    const commitHash = git(['rev-parse', 'HEAD'], worktreeDir);
    return { commitHash, clean: true, committed: false };
  }

  git([...identity, 'commit', '-m', message], worktreeDir);
  const commitHash = git(['rev-parse', 'HEAD'], worktreeDir);
  return { commitHash, clean: false, committed: true };
}

export function mergeBranch({ repoDir, branch, targetBranch = null, message = null }) {
  if (!isGitRepo(repoDir)) {
    throw new Error(`Cannot merge: ${repoDir} is not a git repository`);
  }

  const current = getCurrentBranch(repoDir);
  const target = targetBranch || current;

  if (current !== target) {
    git(['checkout', target], repoDir);
  }

  const commitMsg = message || `Merge branch '${branch}' into '${target}'`;

  try {
    git([...commitIdentityArgs(repoDir), 'merge', '--no-ff', branch, '-m', commitMsg], repoDir);
    const commitHash = git(['rev-parse', 'HEAD'], repoDir);
    return {
      success: true,
      conflict: false,
      commitHash,
      targetBranch: target,
      mergedBranch: branch,
    };
  } catch (err) {
    // Check for merge conflicts
    let conflictingFiles = [];
    try {
      const status = git(['status', '--porcelain'], repoDir);
      conflictingFiles = status
        .split('\n')
        .filter((l) => l.startsWith('UU ') || l.startsWith('AA ') || l.startsWith('UD ') || l.startsWith('DU '))
        .map((l) => l.slice(3).trim());
    } catch { /* best effort */ }

    // Always abort merge on conflict to leave working tree clean
    try {
      git(['merge', '--abort'], repoDir);
    } catch { /* best effort */ }

    return {
      success: false,
      conflict: true,
      conflictingFiles,
      error: err.stderr || err.message,
      targetBranch: target,
      mergedBranch: branch,
    };
  }
}

export function removeWorktree({ repoDir, worktreeDir, branch = null, force = true }) {
  const absWorktreeDir = resolve(worktreeDir);
  try {
    git(['worktree', 'remove', force ? '--force' : '', absWorktreeDir].filter(Boolean), repoDir);
  } catch {
    rmSync(absWorktreeDir, { recursive: true, force: true });
  }

  try {
    git(['worktree', 'prune'], repoDir);
  } catch { /* best effort */ }

  if (branch) {
    try {
      git(['branch', '-D', branch], repoDir);
    } catch { /* best effort */ }
  }
}

export function listWorktrees(repoDir) {
  if (!isGitRepo(repoDir)) return [];
  try {
    const out = git(['worktree', 'list', '--porcelain'], repoDir);
    const entries = [];
    let current = {};
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (current.worktree) entries.push(current);
        current = {};
        continue;
      }
      const [key, ...vals] = trimmed.split(' ');
      const val = vals.join(' ');
      if (key === 'worktree') current.worktree = val;
      else if (key === 'HEAD') current.head = val;
      else if (key === 'branch') current.branch = val;
    }
    if (current.worktree) entries.push(current);
    return entries;
  } catch {
    return [];
  }
}

export class WorktreeSession {
  constructor({ repoDir, taskId, baseDir = null }) {
    this.repoDir = resolve(repoDir);
    this.taskId = taskId;
    this.baseDir = baseDir ? resolve(baseDir) : join(this.repoDir, '.worktrees', taskId);
    this.allocated = new Map(); // step -> { branch, worktreeDir }
  }

  init() {
    ensureGitRepo(this.repoDir);
    mkdirSync(this.baseDir, { recursive: true });
    return this;
  }

  createStepWorktree(stepNumber, { branchPrefix = 'worktree', baseRef = 'HEAD' } = {}) {
    this.init();
    const branch = `${branchPrefix}/${this.taskId}-S${stepNumber}`;
    const worktreeDir = join(this.baseDir, `step-${stepNumber}`);
    const info = createWorktree({
      repoDir: this.repoDir,
      branch,
      worktreeDir,
      baseRef,
    });
    this.allocated.set(stepNumber, info);
    return info;
  }

  commitStep(stepNumber, message = `chore: auto commit step ${stepNumber}`) {
    const info = this.allocated.get(stepNumber);
    if (!info) throw new Error(`Worktree for step ${stepNumber} not found`);
    return commitWorktree({ worktreeDir: info.worktreeDir, message });
  }

  mergeStep(stepNumber, { targetBranch = null, message = null } = {}) {
    const info = this.allocated.get(stepNumber);
    if (!info) throw new Error(`Worktree for step ${stepNumber} not found`);
    return mergeBranch({
      repoDir: this.repoDir,
      branch: info.branch,
      targetBranch,
      message,
    });
  }

  cleanupStep(stepNumber, { deleteBranch = true } = {}) {
    const info = this.allocated.get(stepNumber);
    if (!info) return;
    removeWorktree({
      repoDir: this.repoDir,
      worktreeDir: info.worktreeDir,
      branch: deleteBranch ? info.branch : null,
      force: true,
    });
    this.allocated.delete(stepNumber);
  }

  cleanupAll({ deleteBranches = true } = {}) {
    for (const [stepNumber, info] of [...this.allocated.entries()]) {
      removeWorktree({
        repoDir: this.repoDir,
        worktreeDir: info.worktreeDir,
        branch: deleteBranches ? info.branch : null,
        force: true,
      });
    }
    this.allocated.clear();
    rmSync(this.baseDir, { recursive: true, force: true });
  }
}

/**
 * Groups plan steps into parallel execution batches based on depends_on or parallel_group.
 * If no dependencies or parallel groups are declared, returns sequential 1-step batches.
 */
export function buildPlanBatches(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return [];

  const hasDependencies = plan.some((s) => Array.isArray(s.depends_on));
  const hasParallelGroups = plan.some((s) => s.parallel_group !== undefined);

  if (!hasDependencies && !hasParallelGroups) {
    return plan.map((step) => [step]);
  }

  if (hasDependencies) {
    const stepMap = new Map(plan.map((s) => [s.step, s]));
    const completed = new Set();
    const remaining = new Set(plan.map((s) => s.step));
    const batches = [];

    while (remaining.size > 0) {
      const currentBatch = [];
      for (const stepNum of remaining) {
        const step = stepMap.get(stepNum);
        const deps = step.depends_on || [];
        const allDepsSatisfied = deps.every((d) => completed.has(d));
        if (allDepsSatisfied) {
          currentBatch.push(step);
        }
      }

      if (currentBatch.length === 0) {
        throw new Error('Cyclic or unsatisfiable dependency detected in task plan');
      }

      for (const step of currentBatch) {
        remaining.delete(step.step);
        completed.add(step.step);
      }
      batches.push(currentBatch);
    }
    return batches;
  }

  const batches = [];
  let currentGroup = null;
  let currentBatch = [];

  for (const step of plan) {
    if (step.parallel_group !== undefined) {
      if (currentGroup === step.parallel_group) {
        currentBatch.push(step);
      } else {
        if (currentBatch.length > 0) batches.push(currentBatch);
        currentGroup = step.parallel_group;
        currentBatch = [step];
      }
    } else {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentGroup = null;
      }
      batches.push([step]);
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}
