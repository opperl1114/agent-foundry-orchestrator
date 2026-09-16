// tests/planner-layer.test.mjs - PHASE 9-C Planner Layer Tests
//
// Tests:
//   TEST PL-1: Planner 可以接收 Task Capsule
//   TEST PL-2: Planner 可以生成合法 Task Plan
//   TEST PL-3: Planner 不包含 executor 分配逻辑
//   TEST PL-4: Planner 不可以直接调用 Executor
//   TEST PL-5: Scheduler 可以接收 Planner 输出
//   TEST PL-6: 非法字段 executor/platform 被拒绝

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planTask,
  validateTaskCapsule,
  validateTaskPlan,
  attachPlanToCapsule,
  generatePlanSteps,
  loadTaskPlanSchema,
  DEFAULT_PLANNER_PROVIDER,
  ALLOWED_ROLES,
} from '../planner/planner.mjs';
import './helpers/runtime-state-fixture.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import * as orchestrator from '../orchestrator.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLANNER_DIR = join(ROOT_DIR, 'planner');

function createTempDir(prefix = 'af-pl-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ----------------------------------------------------------------------------
// TEST PL-1: Planner 可以接收 Task Capsule
// ----------------------------------------------------------------------------
test('TEST PL-1: Planner 可以接收 Task Capsule', async () => {
  const validCapsule = {
    task_id: 'TASK-PL1-001',
    goal: '开发商城搜索功能',
    context: '微信小程序项目',
    source: 'conversation-gateway',
    source_agent: 'antigravity',
  };

  // 1. Validation accepts valid capsule
  assert.strictEqual(validateTaskCapsule(validCapsule), true);

  // 2. planTask accepts valid capsule and preserves task identity
  const plan = await planTask(validCapsule);
  assert.strictEqual(plan.task_id, 'TASK-PL1-001');
  assert(Array.isArray(plan.plan), 'plan must be an array');
  assert(plan.plan.length >= 1, 'plan must contain at least one step');

  // 3. Fails closed on missing or malformed input
  assert.throws(() => validateTaskCapsule(null), /invalid_capsule/);
  assert.throws(() => validateTaskCapsule({}), /invalid_capsule/);
  assert.throws(() => validateTaskCapsule({ task_id: 'TASK-1' }), /invalid_capsule/);
  assert.throws(() => validateTaskCapsule({ goal: 'Some goal' }), /invalid_capsule/);
  assert.throws(() => validateTaskCapsule({ task_id: 'TASK-1', goal: '   ' }), /invalid_capsule/);
});

// ----------------------------------------------------------------------------
// TEST PL-2: Planner 可以生成合法 Task Plan
// ----------------------------------------------------------------------------
test('TEST PL-2: Planner 可以生成合法 Task Plan', async () => {
  const capsule = {
    task_id: 'TASK-PL2-001',
    goal: '整理我的 Java 面试知识库',
    context: '生成目录 去重 写入知识库',
  };

  const planResult = await planTask(capsule);

  // 1. Schema structure check
  assert.strictEqual(planResult.task_id, 'TASK-PL2-001');
  assert.strictEqual(planResult.planner_provider, DEFAULT_PLANNER_PROVIDER);
  assert(planResult.summary && typeof planResult.summary === 'string');
  assert(planResult.created_at && typeof planResult.created_at === 'string');
  assert(Array.isArray(planResult.plan) && planResult.plan.length > 0);

  // 2. Step items check
  for (let i = 0; i < planResult.plan.length; i++) {
    const step = planResult.plan[i];
    assert.strictEqual(step.step, i + 1, `Step index must be sequential (${i + 1})`);
    assert(typeof step.goal === 'string' && step.goal.trim().length > 0, 'Step goal must be non-empty string');
    assert(ALLOWED_ROLES.includes(step.role), `Step role "${step.role}" must be one of allowed roles`);
  }

  // 3. JSON schema conformance check
  const schema = loadTaskPlanSchema();
  assert.strictEqual(schema.title, 'AgentFoundryTaskPlan');
  assert(schema.required.includes('task_id'));
  assert(schema.required.includes('plan'));
  assert.strictEqual(schema.properties.plan.items.additionalProperties, false);

  // Full validation check
  assert.strictEqual(validateTaskPlan(planResult), true);
});

// ----------------------------------------------------------------------------
// TEST PL-3: Planner 不包含 executor 分配逻辑
// ----------------------------------------------------------------------------
test('TEST PL-3: Planner 不包含 executor 分配逻辑 (ROLE != PLATFORM invariant)', async () => {
  const capsule = {
    task_id: 'TASK-PL3-001',
    goal: '重构用户登录认证模块并实施安全审计',
    context: 'Node.js JWT microservice',
  };

  const planResult = await planTask(capsule);

  // 1. Root level: strictly no executor or platform bindings
  assert.strictEqual(planResult.executor, undefined, 'Plan root must not contain executor');
  assert.strictEqual(planResult.platform, undefined, 'Plan root must not contain platform');
  assert.strictEqual(planResult.author_executor, undefined, 'Plan root must not contain author_executor');
  assert.strictEqual(planResult.reviewer_executor, undefined, 'Plan root must not contain reviewer_executor');

  // 2. Step level: each step specifies dynamic task role, never a platform identity
  for (const step of planResult.plan) {
    assert.strictEqual(step.executor, undefined, `Step ${step.step} must not specify executor`);
    assert.strictEqual(step.platform, undefined, `Step ${step.step} must not specify platform`);
    assert.strictEqual(step.author_executor, undefined, `Step ${step.step} must not specify author_executor`);
    assert.strictEqual(step.reviewer_executor, undefined, `Step ${step.step} must not specify reviewer_executor`);

    // Ensure role is strictly abstract
    assert(
      ['author', 'reviewer', 'verifier', 'worker', 'researcher'].includes(step.role),
      `Step ${step.step} role must be a generic task role, not a platform`
    );
    assert.notStrictEqual(step.role, 'antigravity');
    assert.notStrictEqual(step.role, 'claude');
    assert.notStrictEqual(step.role, 'codex');
    assert.notStrictEqual(step.role, 'vertex-gemini');
  }
});

// ----------------------------------------------------------------------------
// TEST PL-4: Planner 不可以直接调用 Executor
// ----------------------------------------------------------------------------
test('TEST PL-4: Planner 不可以直接调用 Executor (静态代码与架构边界不变性)', () => {
  assert(existsSync(PLANNER_DIR), 'planner directory must exist');

  // Collect all files in planner directory
  const filesToScan = [
    join(PLANNER_DIR, 'planner.mjs'),
  ];

  const forbiddenExecutionPatterns = [
    /\bADAPTERS\b/,
    /from\s+['"].*adapters\.mjs['"]/i,
    /import\s*\(\s*['"].*adapters\.mjs['"]\s*\)/i,
    /\bexecuteTask\s*\(/,
    /\brunAuthor\s*\(/,
    /\brunReviewer\s*\(/,
    /spawn\s*\(\s*['"`](agy|claude|codex|vertex-gemini)/,
    /bin\/agy-af/,
    /bin\/claude-af/,
    /bin\/vertex-gemini-af/,
  ];

  for (const file of filesToScan) {
    assert(existsSync(file), `Planner file ${file} must exist`);
    const code = readFileSync(file, 'utf8');

    for (const pattern of forbiddenExecutionPatterns) {
      assert.strictEqual(
        pattern.test(code),
        false,
        `Planner file ${file} violates invariant: contains direct executor call or adapter binding (${pattern})`
      );
    }
  }
});

// ----------------------------------------------------------------------------
// TEST PL-5: Scheduler 可以接收 Planner 输出
// ----------------------------------------------------------------------------
test('TEST PL-5: Scheduler 可以接收 Planner 输出', async () => {
  const tmpTasksDir = createTempDir('af-pl5-tasks-');

  try {
    const capsule = {
      task_id: 'TASK-PL5-001',
      goal: '电商结算系统优惠券核销功能开发',
      context: 'Spring Boot 交易结算链路',
      source: 'conversation-gateway',
      source_agent: 'antigravity',
    };

    // 1. Generate plan via Planner
    const plan = await planTask(capsule);
    const enrichedCapsule = attachPlanToCapsule(capsule, plan);

    assert(enrichedCapsule.planner_result, 'Enriched capsule must have planner_result');
    assert.deepStrictEqual(enrichedCapsule.planner_result.plan, plan.plan);

    // 2. Pass to Scheduler
    const sched = new Scheduler({
      tasksDir: tmpTasksDir,
    });

    const enqueuedId = sched.enqueue(enrichedCapsule);
    assert.strictEqual(enqueuedId, 'TASK-PL5-001');
    assert(sched.queue.includes('TASK-PL5-001'), 'Task must enter Scheduler queue');

    // 3. Verify task file persisted on disk includes planner_result
    const taskFilePath = join(tmpTasksDir, 'TASK-PL5-001.json');
    assert(existsSync(taskFilePath), 'Task file must exist on disk');

    const taskOnDisk = JSON.parse(readFileSync(taskFilePath, 'utf8'));
    assert.strictEqual(taskOnDisk.task_id, 'TASK-PL5-001');
    assert.strictEqual(taskOnDisk.state, 'READY');
    assert(taskOnDisk.planner_result, 'Task on disk must preserve planner_result');
    assert.strictEqual(taskOnDisk.planner_result.task_id, 'TASK-PL5-001');
    assert.strictEqual(taskOnDisk.planner_result.plan.length, plan.plan.length);

    // 4. Also test via orchestrator.submitTask with automatic planning
    const rawCapsule = {
      task_id: 'TASK-PL5-AUTO-002',
      goal: '开发商城购物车聚合查询',
      context: 'REST API 接口',
      source: 'conversation-gateway',
    };

    const submitRes = await orchestrator.submitTask(rawCapsule, {
      tasksDir: tmpTasksDir,
      scheduler: sched,
      withPlan: true,
    });

    assert.strictEqual(submitRes.status, 'ACCEPTED');
    assert(submitRes.planner_result, 'submitTask must attach planner_result when withPlan is true');

    const autoTaskOnDisk = JSON.parse(readFileSync(join(tmpTasksDir, 'TASK-PL5-AUTO-002.json'), 'utf8'));
    assert(autoTaskOnDisk.planner_result, 'Automatically planned task must persist planner_result on disk');
    assert(Array.isArray(autoTaskOnDisk.planner_result.plan));

  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST PL-6: 非法字段 executor/platform 被拒绝
// ----------------------------------------------------------------------------
test('TEST PL-6: 非法字段 executor/platform 被拒绝 (fail-closed boundary)', () => {
  const baseValidPlan = {
    task_id: 'TASK-PL6-001',
    planner_provider: 'antigravity',
    plan: [
      { step: 1, goal: '编写业务代码', role: 'author' },
      { step: 2, goal: '独立审查代码', role: 'reviewer' },
    ],
  };

  // 1. Root level illegal bindings
  assert.throws(
    () => validateTaskPlan({ ...baseValidPlan, executor: 'antigravity' }),
    /planner_rejected/,
    'Plan with root executor must be rejected'
  );
  assert.throws(
    () => validateTaskPlan({ ...baseValidPlan, platform: 'claude' }),
    /planner_rejected/,
    'Plan with root platform must be rejected'
  );
  assert.throws(
    () => validateTaskPlan({ ...baseValidPlan, author_executor: 'codex' }),
    /planner_rejected/,
    'Plan with root author_executor must be rejected'
  );
  assert.throws(
    () => validateTaskPlan({ ...baseValidPlan, publish: true }),
    /planner_rejected/,
    'Plan with governance override must be rejected'
  );

  // 2. Step level illegal bindings
  assert.throws(
    () => validateTaskPlan({
      ...baseValidPlan,
      plan: [
        { step: 1, goal: '编写业务代码', role: 'author', executor: 'agy' },
        { step: 2, goal: '独立审查代码', role: 'reviewer' },
      ],
    }),
    /planner_rejected/,
    'Plan step with executor must be rejected'
  );

  assert.throws(
    () => validateTaskPlan({
      ...baseValidPlan,
      plan: [
        { step: 1, goal: '编写业务代码', role: 'author' },
        { step: 2, goal: '独立审查代码', role: 'reviewer', platform: 'claude' },
      ],
    }),
    /planner_rejected/,
    'Plan step with platform must be rejected'
  );

  assert.throws(
    () => validateTaskPlan({
      ...baseValidPlan,
      plan: [
        { step: 1, goal: '编写业务代码', role: 'author', author_executor: 'vertex-gemini' },
      ],
    }),
    /planner_rejected/,
    'Plan step with author_executor must be rejected'
  );

  assert.throws(
    () => validateTaskPlan({
      ...baseValidPlan,
      plan: [
        { step: 1, goal: '编写业务代码', role: 'invalid_role_xyz' },
      ],
    }),
    /planner_rejected/,
    'Plan step with invalid role must be rejected'
  );
});
