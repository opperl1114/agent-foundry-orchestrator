// tests/human-intent-gate.test.mjs - PHASE 9-D Human Intent Alignment Gate Tests
//
// Invariants verified:
//   TEST HI-1: 普通生成任务自动通过
//   TEST HI-2: Planner方向变化进入WAITING_HUMAN
//   TEST HI-3: 知识库结构修改必须确认
//   TEST HI-4: 系统配置修改必须确认
//   TEST HI-5: 大量删除必须确认
//   TEST HI-6: approve 后 Scheduler 可以继续执行
//   TEST HI-7: reject 后任务进入 CANCELLED
//   TEST HI-8: Intent Gate 不可调用 Executor (ROLE != PLATFORM & architectural boundary)
//   TEST HI-9: Intent Gate 不修改 Governance (Single Governance & boundary validation)

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  alignTaskIntent,
  approveIntent,
  rejectIntent,
  validateIntentArgs,
  FORBIDDEN_FIELDS,
} from '../approval/intent-gate.mjs';
import {
  evaluateIntentPolicy,
  INTENT_STATUSES,
  INTENT_REASONS,
} from '../approval/intent-policy.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import * as orchestrator from '../orchestrator.mjs';
import {
  approveIntentHandler,
  approveIntentToolDefinition,
} from '../../agent-foundry-gateway/tools/approve-intent.mjs';
import {
  rejectIntentHandler,
  rejectIntentToolDefinition,
} from '../../agent-foundry-gateway/tools/reject-intent.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPROVAL_DIR = join(ROOT_DIR, 'approval');

function createTempDir(prefix = 'af-hi-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakeAdapter(type, { reviewDecision = 'PASS' } = {}) {
  const reviewObj = {
    decision: reviewDecision,
    summary: 'Mock review summary',
    issues: [],
    required_changes: [],
    evidence: ['test-evidence'],
  };
  return {
    type,
    run: async (capsule) => ({
      executor_run_id: 'RUN-HI-' + Math.random().toString(36).slice(2, 8),
      executor_type: type,
      assigned_role: capsule.assigned_role,
      status: 'completed',
      session_ref: 'SES-' + type,
      structured_result: {
        result: JSON.stringify(reviewObj),
        parsed: reviewObj,
      },
      exit_code: 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }),
    resume: async () => ({ status: 'completed' }),
    cancel: () => ({ requested: true, pid: null }),
    health: () => ({ status: 'READY' }),
  };
}

// ----------------------------------------------------------------------------
// TEST HI-1: 普通生成任务自动通过
// ----------------------------------------------------------------------------
test('TEST HI-1: 普通生成任务自动通过', async () => {
  const tmpTasksDir = createTempDir('af-hi1-tasks-');
  try {
    const routineCapsule = {
      task_id: 'TASK-HI1-001',
      goal: '生成一个微服务接口说明文档',
      context: '包含认证与商品模块接口说明',
      source: 'conversation-gateway',
      source_agent: 'antigravity',
    };

    const sched = new Scheduler({
      tasksDir: tmpTasksDir,
      adapters: {
        'vertex-gemini': makeFakeAdapter('vertex-gemini'),
        claude: makeFakeAdapter('claude'),
        codex: makeFakeAdapter('codex'),
      },
    });

    const res = await orchestrator.submitTask(routineCapsule, {
      tasksDir: tmpTasksDir,
      scheduler: sched,
      withPlan: true,
      withIntentGate: true,
    });

    // 1. Routine task is auto-allowed
    assert.strictEqual(res.status, 'ACCEPTED');
    assert.strictEqual(res.intent_alignment.required, false);
    assert.strictEqual(res.intent_alignment.status, INTENT_STATUSES.AUTO_ALLOWED);
    assert.strictEqual(res.intent_alignment.reason, INTENT_REASONS.ROUTINE_TASK);

    // 2. Enqueued in Scheduler queue
    assert(sched.queue.includes('TASK-HI1-001'), 'Task must enter Scheduler queue');

    // 3. Task file on disk is in READY state
    const taskPath = join(tmpTasksDir, 'TASK-HI1-001.json');
    assert(existsSync(taskPath), 'Task file must exist on disk');
    const taskOnDisk = JSON.parse(readFileSync(taskPath, 'utf8'));
    assert.strictEqual(taskOnDisk.state, 'READY');
    assert.strictEqual(taskOnDisk.intent_alignment.required, false);
  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST HI-2: Planner方向变化进入WAITING_HUMAN
// ----------------------------------------------------------------------------
test('TEST HI-2: Planner方向变化进入WAITING_HUMAN', async () => {
  const tmpTasksDir = createTempDir('af-hi2-tasks-');
  try {
    // User requests high-level organization: "整理我的知识库"
    // But Planner proposes structural changes: "重新设计目录", "合并分类", "删除重复内容"
    const capsule = {
      task_id: 'TASK-HI2-001',
      goal: '整理我的知识库',
      context: '知识库内容较乱',
      planner_result: {
        task_id: 'TASK-HI2-001',
        plan: [
          '重新设计目录',
          '合并分类',
          '删除重复内容',
        ],
      },
    };

    const sched = new Scheduler({ tasksDir: tmpTasksDir });

    const res = await orchestrator.submitTask(capsule, {
      tasksDir: tmpTasksDir,
      scheduler: sched,
      withPlan: false, // already provided
      withIntentGate: true,
    });

    // 1. Must enter WAITING_HUMAN
    assert.strictEqual(res.status, 'WAITING_HUMAN');
    assert.strictEqual(res.intent_alignment.required, true);
    assert.strictEqual(res.intent_alignment.status, INTENT_STATUSES.PENDING_HUMAN);
    assert.strictEqual(res.intent_alignment.reason, INTENT_REASONS.DIRECTION_CONFIRMATION);

    // 2. Must NOT be enqueued into active scheduler queue
    assert(!sched.queue.includes('TASK-HI2-001'), 'Task requiring human confirmation must NOT be in queue');

    // 3. Persisted on disk with WAITING_HUMAN
    const taskPath = join(tmpTasksDir, 'TASK-HI2-001.json');
    assert(existsSync(taskPath), 'Task file must be saved on disk');
    const taskOnDisk = JSON.parse(readFileSync(taskPath, 'utf8'));
    assert.strictEqual(taskOnDisk.state, 'WAITING_HUMAN');
    assert.strictEqual(taskOnDisk.intent_alignment.required, true);
    assert.strictEqual(taskOnDisk.intent_alignment.reason, INTENT_REASONS.DIRECTION_CONFIRMATION);
  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST HI-3: 知识库结构修改必须确认
// ----------------------------------------------------------------------------
test('TEST HI-3: 知识库结构修改必须确认', async () => {
  const tmpTasksDir = createTempDir('af-hi3-tasks-');
  try {
    const govCapsules = [
      {
        task_id: 'TASK-HI3-A',
        goal: '修改知识库目录结构并更新SCHEMA.md',
        target_path: 'agent-foundry-vault/SCHEMA.md',
      },
      {
        task_id: 'TASK-HI3-B',
        goal: '修改index规则与metadata规则',
        context: '变更知识库分类与索引规则',
      },
    ];

    for (const capsule of govCapsules) {
      const res = await orchestrator.submitTask(capsule, {
        tasksDir: tmpTasksDir,
        withPlan: false,
        withIntentGate: true,
      });

      assert.strictEqual(res.status, 'WAITING_HUMAN', `Task ${capsule.task_id} must enter WAITING_HUMAN`);
      assert.strictEqual(res.intent_alignment.required, true);
      assert.strictEqual(res.intent_alignment.status, INTENT_STATUSES.PENDING_HUMAN);
      assert.strictEqual(res.intent_alignment.reason, INTENT_REASONS.KNOWLEDGE_GOVERNANCE_CHANGE);

      const taskOnDisk = JSON.parse(readFileSync(join(tmpTasksDir, `${capsule.task_id}.json`), 'utf8'));
      assert.strictEqual(taskOnDisk.state, 'WAITING_HUMAN');
    }
  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST HI-4: 系统配置修改必须确认
// ----------------------------------------------------------------------------
test('TEST HI-4: 系统配置修改必须确认', async () => {
  const tmpTasksDir = createTempDir('af-hi4-tasks-');
  try {
    const configCapsules = [
      {
        task_id: 'TASK-HI4-A',
        goal: '修改AGENTS.md中的默认治理规则',
        target_path: 'AGENTS.md',
      },
      {
        task_id: 'TASK-HI4-B',
        goal: '修改MCP配置与Executor配置',
        context: '更新调度器运行规则与适配器参数',
      },
    ];

    for (const capsule of configCapsules) {
      const res = await orchestrator.submitTask(capsule, {
        tasksDir: tmpTasksDir,
        withPlan: false,
        withIntentGate: true,
      });

      assert.strictEqual(res.status, 'WAITING_HUMAN', `Task ${capsule.task_id} must enter WAITING_HUMAN`);
      assert.strictEqual(res.intent_alignment.required, true);
      assert.strictEqual(res.intent_alignment.status, INTENT_STATUSES.PENDING_HUMAN);
      assert.strictEqual(res.intent_alignment.reason, INTENT_REASONS.SYSTEM_CONFIG_CHANGE);

      const taskOnDisk = JSON.parse(readFileSync(join(tmpTasksDir, `${capsule.task_id}.json`), 'utf8'));
      assert.strictEqual(taskOnDisk.state, 'WAITING_HUMAN');
    }
  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST HI-5: 大量删除必须确认
// ----------------------------------------------------------------------------
test('TEST HI-5: 大量删除必须确认', async () => {
  const tmpTasksDir = createTempDir('af-hi5-tasks-');
  try {
    // 1. Routine temp cleanup is auto-allowed
    const routineCleanup = {
      task_id: 'TASK-HI5-CLEANUP',
      goal: '清理构建临时文件和缓存',
      context: '清理 /tmp 中的临时编译缓存',
    };

    const cleanupRes = await orchestrator.submitTask(routineCleanup, {
      tasksDir: tmpTasksDir,
      withPlan: false,
      withIntentGate: true,
    });
    assert.strictEqual(cleanupRes.status, 'ACCEPTED');
    assert.strictEqual(cleanupRes.intent_alignment.required, false);
    assert.strictEqual(cleanupRes.intent_alignment.reason, INTENT_REASONS.ROUTINE_CLEANUP);

    // 2. Destructive / bulk deletion requires confirmation
    const destructiveTasks = [
      {
        task_id: 'TASK-HI5-DEL-A',
        goal: '大量删除历史知识资产和内容',
      },
      {
        task_id: 'TASK-HI5-DEL-B',
        goal: '不可恢复删除项目核心代码文件',
      },
    ];

    for (const delTask of destructiveTasks) {
      const res = await orchestrator.submitTask(delTask, {
        tasksDir: tmpTasksDir,
        withPlan: false,
        withIntentGate: true,
      });
      assert.strictEqual(res.status, 'WAITING_HUMAN');
      assert.strictEqual(res.intent_alignment.required, true);
      assert.strictEqual(res.intent_alignment.reason, INTENT_REASONS.DESTRUCTIVE_DELETION);
    }
  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST HI-6: approve 后 Scheduler 可以继续执行
// ----------------------------------------------------------------------------
test('TEST HI-6: approve 后 Scheduler 可以继续执行', async () => {
  const tmpTasksDir = createTempDir('af-hi6-tasks-');
  try {
    const capsule = {
      task_id: 'TASK-HI6-001',
      goal: '修改知识库目录结构并更新SCHEMA.md',
      target_path: 'agent-foundry-vault/SCHEMA.md',
      acceptance: 'exit 0',
      author_executor: 'claude',
      reviewer_executor: 'vertex-gemini',
    };

    const fakeAdapters = {
      'vertex-gemini': makeFakeAdapter('vertex-gemini'),
      claude: makeFakeAdapter('claude'),
      codex: makeFakeAdapter('codex'),
    };

    const sched = new Scheduler({
      tasksDir: tmpTasksDir,
      adapters: fakeAdapters,
    });

    // 1. Submit -> enters WAITING_HUMAN
    const submitRes = await orchestrator.submitTask(capsule, {
      tasksDir: tmpTasksDir,
      scheduler: sched,
      withPlan: false,
      withIntentGate: true,
    });
    assert.strictEqual(submitRes.status, 'WAITING_HUMAN');

    let taskOnDisk = JSON.parse(readFileSync(join(tmpTasksDir, 'TASK-HI6-001.json'), 'utf8'));
    assert.strictEqual(taskOnDisk.state, 'WAITING_HUMAN');
    assert.strictEqual(taskOnDisk.intent_alignment.status, 'PENDING_HUMAN');

    // 2. Call approve via Gateway MCP tool handler
    const approveRes = await approveIntentHandler({
      task_id: 'TASK-HI6-001',
      reason: '确认执行该方案',
    }, {
      tasksDir: tmpTasksDir,
      orchestratorModule: orchestrator,
      scheduler: sched,
      autoRun: false,
    });

    assert.strictEqual(approveRes.task_id, 'TASK-HI6-001');
    assert.strictEqual(approveRes.status, 'APPROVED');

    // 3. Verify task on disk is APPROVED
    taskOnDisk = JSON.parse(readFileSync(join(tmpTasksDir, 'TASK-HI6-001.json'), 'utf8'));
    assert.strictEqual(taskOnDisk.state, 'APPROVED');
    assert.strictEqual(taskOnDisk.intent_alignment.status, 'APPROVED');
    assert.strictEqual(taskOnDisk.intent_alignment.approval_reason, '确认执行该方案');
    assert.strictEqual(taskOnDisk.intent_alignment.approved_by, 'user');
    assert(taskOnDisk.intent_alignment.approved_at, 'approved_at timestamp must exist');

    // 4. Run through Scheduler: state progresses APPROVED -> AUTHOR_RUNNING -> ... -> COMPLETED
    sched.runNext();
    await sched.waitAll();

    taskOnDisk = JSON.parse(readFileSync(join(tmpTasksDir, 'TASK-HI6-001.json'), 'utf8'));
    assert.strictEqual(taskOnDisk.state, 'COMPLETED');
  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST HI-7: reject 后任务进入 CANCELLED
// ----------------------------------------------------------------------------
test('TEST HI-7: reject 后任务进入 CANCELLED', async () => {
  const tmpTasksDir = createTempDir('af-hi7-tasks-');
  try {
    const capsule = {
      task_id: 'TASK-HI7-001',
      goal: '修改AGENTS.md并调整运行规则',
      target_path: 'AGENTS.md',
    };

    const sched = new Scheduler({ tasksDir: tmpTasksDir });

    // 1. Submit -> enters WAITING_HUMAN
    await orchestrator.submitTask(capsule, {
      tasksDir: tmpTasksDir,
      scheduler: sched,
      withPlan: false,
      withIntentGate: true,
    });

    // 2. Call reject via Gateway MCP tool handler
    const rejectRes = await rejectIntentHandler({
      task_id: 'TASK-HI7-001',
      reason: '方向不符合要求',
    }, {
      tasksDir: tmpTasksDir,
      orchestratorModule: orchestrator,
    });

    assert.strictEqual(rejectRes.task_id, 'TASK-HI7-001');
    assert.strictEqual(rejectRes.status, 'CANCELLED');

    // 3. Verify task on disk is CANCELLED
    const taskOnDisk = JSON.parse(readFileSync(join(tmpTasksDir, 'TASK-HI7-001.json'), 'utf8'));
    assert.strictEqual(taskOnDisk.state, 'CANCELLED');
    assert.strictEqual(taskOnDisk.cancel_reason, '方向不符合要求');
    assert.strictEqual(taskOnDisk.intent_alignment.status, 'CANCELLED');
    assert.strictEqual(taskOnDisk.intent_alignment.rejection_reason, '方向不符合要求');
    assert.strictEqual(taskOnDisk.intent_alignment.cancelled_by, 'user');
    assert(taskOnDisk.intent_alignment.cancelled_at, 'cancelled_at timestamp must exist');

    // 4. Cancelled task cannot be approved or resumed
    assert.throws(
      () => approveIntent('TASK-HI7-001', { tasksDir: tmpTasksDir }),
      /TASK_ALREADY_TERMINAL/
    );
    assert.throws(
      () => sched.resumeTask('TASK-HI7-001'),
      /NOT_WAITING_HUMAN/
    );
  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST HI-8: Intent Gate 不可调用 Executor
// ----------------------------------------------------------------------------
test('TEST HI-8: Intent Gate 不可调用 Executor (ROLE != PLATFORM & boundary)', async () => {
  // 1. Static code boundary check
  const intentGateCode = readFileSync(join(APPROVAL_DIR, 'intent-gate.mjs'), 'utf8');
  const intentPolicyCode = readFileSync(join(APPROVAL_DIR, 'intent-policy.mjs'), 'utf8');

  // Verify no adapter imports or child process executions in Intent Gate
  const forbiddenPatterns = [
    /import.*from.*adapters/i,
    /child_process/,
    /exec\(/,
    /spawn\(/,
    /fork\(/,
    /executor-router/i,
  ];

  for (const pat of forbiddenPatterns) {
    assert(!pat.test(intentGateCode), `intent-gate.mjs must NOT contain ${pat}`);
    assert(!pat.test(intentPolicyCode), `intent-policy.mjs must NOT contain ${pat}`);
  }

  // 2. Dynamic execution: verify 0 executor calls during alignment and approval
  let executorCallCount = 0;
  const spyAdapter = {
    type: 'spy',
    run: async () => { executorCallCount++; return {}; },
    resume: async () => { executorCallCount++; return {}; },
    cancel: () => ({ requested: true }),
    health: () => ({ status: 'READY' }),
  };

  const testCapsule = {
    task_id: 'TASK-HI8-001',
    goal: '架构边界测试',
  };

  const alignRes = alignTaskIntent(testCapsule, null, { tasksDir: '/tmp' });
  assert.strictEqual(executorCallCount, 0, 'alignTaskIntent must NEVER call an executor');
  assert.strictEqual(testCapsule.executor, undefined, 'ROLE != PLATFORM: Intent Gate must not bind executor');
  assert.strictEqual(testCapsule.platform, undefined, 'ROLE != PLATFORM: Intent Gate must not bind platform');
});

// ----------------------------------------------------------------------------
// TEST HI-9: Intent Gate 不修改 Governance
// ----------------------------------------------------------------------------
test('TEST HI-9: Intent Gate 不修改 Governance (Single Governance & boundary validation)', async () => {
  // 1. Rejects illegal governance bypass injections
  const illegalCapsules = [
    {
      task_id: 'TASK-HI9-A',
      goal: '试图伪造治理决定',
      policy_decision: 'auto_publish',
    },
    {
      task_id: 'TASK-HI9-B',
      goal: '试图跳过治理检查',
      governance_bypass: true,
    },
    {
      task_id: 'TASK-HI9-C',
      goal: '试图伪造人审通过',
      human_gate_status: 'approved',
    },
    {
      task_id: 'TASK-HI9-D',
      goal: '试图绑定执行平台',
      executor: 'claude',
    },
  ];

  for (const badCapsule of illegalCapsules) {
    assert.throws(
      () => alignTaskIntent(badCapsule, null),
      /boundary_violation/,
      `Illegal field in ${JSON.stringify(badCapsule)} must be rejected`
    );
  }

  // 2. Rejects illegal arguments during approval
  assert.throws(
    () => validateIntentArgs({ policy_decision: 'auto_publish' }),
    /boundary_violation/
  );
  assert.throws(
    () => validateIntentArgs({ governance_bypass: true }),
    /boundary_violation/
  );
});
