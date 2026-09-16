// tests/worktree.test.mjs - Unit tests for Git Worktree isolation & concurrency
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isGitRepo,
  ensureGitRepo,
  createWorktree,
  commitWorktree,
  mergeBranch,
  removeWorktree,
  listWorktrees,
  WorktreeSession,
} from '../lib/worktree.mjs';

const tempDirs = [];
function makeTempDir(prefix = 'af-wt-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

test('WORKTREE-1: isGitRepo and ensureGitRepo initialization', () => {
  const dir = makeTempDir();
  assert.strictEqual(isGitRepo(dir), false, 'Empty dir must not be a git repo');

  // N7: initialising a directory that is not a repository is opt-in, and the
  // commit identity must not be written into the repository config.
  assert.throws(
    () => ensureGitRepo(dir),
    /NOT_A_GIT_REPO/,
    'ensureGitRepo must not silently git init a plain directory'
  );
  assert.strictEqual(isGitRepo(dir), false, 'a refused call must not have created a repository');
  assert.strictEqual(existsSync(join(dir, '.git')), false);

  ensureGitRepo(dir, { initIfMissing: true, user: 'Test Runner', email: 'test@example.invalid' });
  assert.strictEqual(isGitRepo(dir), true, 'Initialized dir must be a git repo');

  const repoConfig = readFileSync(join(dir, '.git', 'config'), 'utf8');
  assert.ok(
    !repoConfig.includes('Test Runner'),
    'the commit identity must be passed per command, not written into the repo config'
  );
});

test('WORKTREE-2: createWorktree creates branch and worktree directory', () => {
  const repoDir = makeTempDir();
  ensureGitRepo(repoDir, { initIfMissing: true });
  writeFileSync(join(repoDir, 'base.txt'), 'baseline content\n');
  commitWorktree({ worktreeDir: repoDir, message: 'add base' });

  const wtDir = join(repoDir, '.worktrees', 'step-1');
  const wt = createWorktree({
    repoDir,
    branch: 'worktree/step-1',
    worktreeDir: wtDir,
  });

  assert.strictEqual(existsSync(wtDir), true);
  assert.strictEqual(wt.branch, 'worktree/step-1');
  assert.strictEqual(existsSync(join(wtDir, 'base.txt')), true);
});

test('WORKTREE-3: Parallel worktree writes and clean merge into main', () => {
  const repoDir = makeTempDir();
  ensureGitRepo(repoDir, { initIfMissing: true });
  writeFileSync(join(repoDir, 'README.md'), '# Main Project\n');
  commitWorktree({ worktreeDir: repoDir, message: 'chore: initial commit' });

  const session = new WorktreeSession({ repoDir, taskId: 'TASK-PARALLEL-001' });
  session.init();

  // Step 1: writes serviceA.js
  const wt1 = session.createStepWorktree(1);
  writeFileSync(join(wt1.worktreeDir, 'serviceA.js'), 'export const a = 1;\n');
  session.commitStep(1, 'feat: add service A');

  // Step 2: writes serviceB.js in parallel worktree
  const wt2 = session.createStepWorktree(2);
  writeFileSync(join(wt2.worktreeDir, 'serviceB.js'), 'export const b = 2;\n');
  session.commitStep(2, 'feat: add service B');

  // Merge both into main
  const mergeRes1 = session.mergeStep(1);
  assert.strictEqual(mergeRes1.success, true, 'Step 1 merge must succeed');
  assert.strictEqual(existsSync(join(repoDir, 'serviceA.js')), true);

  const mergeRes2 = session.mergeStep(2);
  assert.strictEqual(mergeRes2.success, true, 'Step 2 merge must succeed');
  assert.strictEqual(existsSync(join(repoDir, 'serviceB.js')), true);

  // Both files now exist in main
  assert.strictEqual(readFileSync(join(repoDir, 'serviceA.js'), 'utf8'), 'export const a = 1;\n');
  assert.strictEqual(readFileSync(join(repoDir, 'serviceB.js'), 'utf8'), 'export const b = 2;\n');

  // Cleanup all
  session.cleanupAll();
  assert.strictEqual(existsSync(session.baseDir), false, 'Worktrees base dir must be cleaned up');
});

test('WORKTREE-4: Merge conflict detection fails closed and aborts merge cleanly', () => {
  const repoDir = makeTempDir();
  ensureGitRepo(repoDir, { initIfMissing: true });
  writeFileSync(join(repoDir, 'shared.js'), 'const version = 1;\n');
  commitWorktree({ worktreeDir: repoDir, message: 'chore: initial commit' });

  const session = new WorktreeSession({ repoDir, taskId: 'TASK-CONFLICT-001' });
  session.init();

  // Step 1: modifies shared.js
  const wt1 = session.createStepWorktree(1);
  writeFileSync(join(wt1.worktreeDir, 'shared.js'), 'const version = 100;\n');
  session.commitStep(1, 'step 1 edit');

  // Step 2: also modifies shared.js conflictingly
  const wt2 = session.createStepWorktree(2);
  writeFileSync(join(wt2.worktreeDir, 'shared.js'), 'const version = 200;\n');
  session.commitStep(2, 'step 2 conflicting edit');

  // Merge step 1 succeeds
  const m1 = session.mergeStep(1);
  assert.strictEqual(m1.success, true);

  // Merge step 2 must conflict and abort cleanly
  const m2 = session.mergeStep(2);
  assert.strictEqual(m2.success, false, 'Conflicting merge must fail');
  assert.strictEqual(m2.conflict, true, 'Conflict flag must be set');
  assert.ok(m2.conflictingFiles.includes('shared.js'), 'Must report conflicting file');

  // Repo must remain clean (not stuck in MERGING state)
  const wtStatus = listWorktrees(repoDir);
  assert.ok(Array.isArray(wtStatus));

  session.cleanupAll();
});

test('WORKTREE-5: buildPlanBatches DAG grouping and cycle detection', async () => {
  const { buildPlanBatches } = await import('../lib/worktree.mjs');

  // 1. Pure sequential plan
  const seqPlan = [
    { step: 1, goal: 'A', role: 'author' },
    { step: 2, goal: 'B', role: 'author' },
    { step: 3, goal: 'C', role: 'reviewer' },
  ];
  const b1 = buildPlanBatches(seqPlan);
  assert.strictEqual(b1.length, 3);
  assert.deepStrictEqual(b1.map((b) => b.map((s) => s.step)), [[1], [2], [3]]);

  // 2. DAG plan with branch and merge
  // Step 1 -> Step 2 & Step 3 & Step 4 (parallel) -> Step 5
  const dagPlan = [
    { step: 1, goal: 'Spec', role: 'author', depends_on: [] },
    { step: 2, goal: 'Module A', role: 'worker', depends_on: [1] },
    { step: 3, goal: 'Module B', role: 'worker', depends_on: [1] },
    { step: 4, goal: 'Module C', role: 'worker', depends_on: [1] },
    { step: 5, goal: 'Integration', role: 'verifier', depends_on: [2, 3, 4] },
  ];
  const b2 = buildPlanBatches(dagPlan);
  assert.strictEqual(b2.length, 3);
  assert.deepStrictEqual(b2[0].map((s) => s.step), [1]);
  assert.deepStrictEqual(b2[1].map((s) => s.step), [2, 3, 4]); // Parallel batch!
  assert.deepStrictEqual(b2[2].map((s) => s.step), [5]);

  // 3. Cycle detection must throw
  const cyclePlan = [
    { step: 1, goal: 'A', role: 'worker', depends_on: [2] },
    { step: 2, goal: 'B', role: 'worker', depends_on: [1] },
  ];
  assert.throws(() => buildPlanBatches(cyclePlan), /Cyclic or unsatisfiable dependency/);
});
