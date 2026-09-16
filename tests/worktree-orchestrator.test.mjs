// tests/worktree-orchestrator.test.mjs - End-to-end test for DAG plans with Git Worktree parallel execution
import { test, afterEach } from 'node:test';
import './helpers/executors-fixture.mjs';
import './helpers/tasks-dir-fixture.mjs';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeTask } from '../orchestrator.mjs';
import { ensureGitRepo, commitWorktree } from '../lib/worktree.mjs';
import './helpers/acceptance-allowlist.mjs';

const tempDirs = [];
function makeTempDir(prefix = 'af-orch-wt-') {
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

function makeFakeAdapter(type, onRun) {
  return {
    type,
    supportsMcpUnattended: true,
    async run(capsule) {
      if (onRun) await onRun(capsule);
      const isReview = capsule.assigned_role === 'verifier' || capsule.assigned_role === 'reviewer';
      return {
        executor_run_id: `RUN-${randomUUID().slice(0, 8)}`,
        executor_type: type,
        assigned_role: capsule.assigned_role,
        status: 'completed',
        exit_code: 0,
        structured_result: isReview
          ? { result: '```json\n{"decision":"PASS","reason":"verified cleanly","confidence":1.0}\n```' }
          : { result: `Success from ${type} in ${capsule.cwd}` },
        stdout: isReview
          ? '```json\n{"decision":"PASS","reason":"verified cleanly","confidence":1.0}\n```'
          : `Done in ${capsule.cwd}`,
        stderr: '',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
      };
    },
    async resume(sessionRef, capsule) {
      return this.run(capsule);
    },
    cancel() {
      return { cancelled: true };
    },
  };
}

test('ORCH-WT-1: Multi-step DAG with parallel Git Worktrees completes and merges cleanly', async () => {
  const repoDir = makeTempDir();
  ensureGitRepo(repoDir, { initIfMissing: true });
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'wt-test', version: '1.0.0' }));
  commitWorktree({ worktreeDir: repoDir, message: 'chore: initial baseline' });

  const executedCwds = [];

  const fakeCodex = makeFakeAdapter('codex', async (capsule) => {
    executedCwds.push({ role: capsule.assigned_role, cwd: capsule.cwd });
    if (capsule.task_id.endsWith('-S1')) {
      writeFileSync(join(capsule.cwd, 'step1.txt'), 'step 1 output\n');
    } else if (capsule.task_id.endsWith('-S2')) {
      writeFileSync(join(capsule.cwd, 'moduleA.js'), 'export const a = 100;\n');
    }
  });

  const fakeCline = makeFakeAdapter('cline', async (capsule) => {
    executedCwds.push({ role: capsule.assigned_role, cwd: capsule.cwd });
    if (capsule.task_id.endsWith('-S3')) {
      writeFileSync(join(capsule.cwd, 'moduleB.js'), 'export const b = 200;\n');
    }
  });

  const adapters = { codex: fakeCodex, cline: fakeCline };

  const task = {
    task_id: `TASK-WT-${randomUUID().slice(0, 8)}`,
    goal: 'Build modular system with parallel services',
    fixture_dir: repoDir,
    author_role: 'worker',
    author_executor: 'codex',
    multi_step_dispatch: true,
    enable_worktree: true,
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    planner_result: {
      plan: [
        { step: 1, goal: 'Init core', role: 'worker', depends_on: [] },
        { step: 2, goal: 'Build Module A', role: 'worker', depends_on: [1] },
        { step: 3, goal: 'Build Module B', role: 'worker', depends_on: [1] },
        { step: 4, goal: 'Verify modules', role: 'verifier', depends_on: [2, 3] },
      ],
    },
    step_executors: {
      1: 'codex',
      2: 'codex',
      3: 'cline',
      4: 'cline',
    },
  };

  const completedTask = await executeTask(task, adapters);
  if (completedTask.state !== 'COMPLETED') {
    console.error('Task failed with failure_reason:', completedTask.failure_reason);
  }

  assert.strictEqual(completedTask.state, 'COMPLETED');
  assert.strictEqual(completedTask.plan_execution.length, 4);

  // Verify that Step 2 and Step 3 executed in isolated worktree dirs (not repoDir directly)
  const step2Cwd = executedCwds.find((c) => c.cwd.includes('step-2'));
  const step3Cwd = executedCwds.find((c) => c.cwd.includes('step-3'));
  assert.ok(step2Cwd, 'Step 2 must execute inside dedicated worktree');
  assert.ok(step3Cwd, 'Step 3 must execute inside dedicated worktree');
  assert.notStrictEqual(step2Cwd.cwd, step3Cwd.cwd, 'Step 2 and Step 3 worktree dirs must differ');

  // Verify that both module files have been successfully merged into repoDir
  assert.strictEqual(existsSync(join(repoDir, 'step1.txt')), true);
  assert.strictEqual(existsSync(join(repoDir, 'moduleA.js')), true);
  assert.strictEqual(existsSync(join(repoDir, 'moduleB.js')), true);
  assert.strictEqual(readFileSync(join(repoDir, 'moduleA.js'), 'utf8'), 'export const a = 100;\n');
  assert.strictEqual(readFileSync(join(repoDir, 'moduleB.js'), 'utf8'), 'export const b = 200;\n');

  // Verify worktree directories are cleaned up
  assert.strictEqual(existsSync(join(repoDir, '.worktrees', task.task_id)), false);
});

test('ORCH-WT-2: Parallel worktrees with merge conflict fails closed and records MERGE_CONFLICT', async () => {
  const repoDir = makeTempDir();
  ensureGitRepo(repoDir, { initIfMissing: true });
  writeFileSync(join(repoDir, 'shared.js'), 'const version = 1;\n');
  commitWorktree({ worktreeDir: repoDir, message: 'chore: initial shared file' });

  // Both codex and cline edit the same line in shared.js
  const fakeCodex = makeFakeAdapter('codex', async (capsule) => {
    writeFileSync(join(capsule.cwd, 'shared.js'), 'const version = "BRANCH_A";\n');
  });

  const fakeCline = makeFakeAdapter('cline', async (capsule) => {
    writeFileSync(join(capsule.cwd, 'shared.js'), 'const version = "BRANCH_B";\n');
  });

  const adapters = { codex: fakeCodex, cline: fakeCline };

  const task = {
    task_id: `TASK-WT-CONFLICT-${randomUUID().slice(0, 8)}`,
    goal: 'Test conflicting edits',
    fixture_dir: repoDir,
    author_role: 'worker',
    author_executor: 'codex',
    multi_step_dispatch: true,
    enable_worktree: true,
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    planner_result: {
      plan: [
        { step: 1, goal: 'Conflicting edit 1', role: 'worker', depends_on: [] },
        { step: 2, goal: 'Conflicting edit 2', role: 'worker', depends_on: [] },
      ],
    },
    step_executors: {
      1: 'codex',
      2: 'cline',
    },
  };

  const completedTask = await executeTask(task, adapters);

  assert.strictEqual(completedTask.state, 'FAILED');
  assert.ok(completedTask.failure_reason.includes('Merge conflict'));
  assert.ok(completedTask.failure_reason.includes('shared.js'));

  // Repo must remain clean and worktrees cleaned up
  assert.strictEqual(existsSync(join(repoDir, '.worktrees', task.task_id)), false);
});
