// planner.mjs - Agent Foundry Planner Layer (PHASE 9-C)
//
// Invariants:
//   1. Understands user goal, decomposes task, generates execution plan.
//   2. Strictly enforces ROLE != PLATFORM: Planner NEVER decides executors or platforms.
//   3. Planner CANNOT directly execute tasks or call execution engines (agy/claude/codex).
//   4. Planner CANNOT bypass Scheduler: Scheduler retains full lifecycle ownership.
//   5. Fixed Provider v1: "antigravity" (capability provider only, NOT a platform role binding).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveActionProposal,
  CURRENT_CONTRACT_VERSION,
} from '../intent/action-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PLANNER_PROVIDER = 'antigravity';

export const ALLOWED_ROLES = Object.freeze([
  'author',
  'reviewer',
  'verifier',
  'worker',
  'researcher',
]);

export const FORBIDDEN_FIELDS = Object.freeze([
  'executor',
  'platform',
  'author_executor',
  'reviewer_executor',
  'publish',
  'policy_decision',
  'human_gate_status',
  'governance_bypass',
  'credential',
  'token',
  'api_key',
  'risk',
]);

/**
 * Load Task Plan JSON Schema
 */
export function loadTaskPlanSchema() {
  const schemaPath = join(__dirname, 'schema', 'task-plan.schema.json');
  return JSON.parse(readFileSync(schemaPath, 'utf8'));
}

/**
 * Validate input Task Capsule from Gateway
 */
export function validateTaskCapsule(capsule) {
  if (!capsule || typeof capsule !== 'object') {
    throw new Error('[invalid_capsule] Task Capsule must be a non-null object');
  }
  if (!capsule.task_id || typeof capsule.task_id !== 'string' || !capsule.task_id.trim()) {
    throw new Error('[invalid_capsule] Task Capsule must contain a valid "task_id"');
  }
  if (!capsule.goal || typeof capsule.goal !== 'string' || !capsule.goal.trim()) {
    throw new Error('[invalid_capsule] Task Capsule must contain a valid "goal"');
  }
  return true;
}

/**
 * Validate generated Task Plan strictly enforcing ROLE != PLATFORM and schema rules
 */
export function validateTaskPlan(planObj) {
  if (!planObj || typeof planObj !== 'object') {
    throw new Error('[planner_rejected] Task Plan must be a non-null object');
  }

  // Check forbidden fields at root
  for (const field of FORBIDDEN_FIELDS) {
    if (field in planObj) {
      throw new Error(`[planner_rejected] Illegal field "${field}" detected in Task Plan root (ROLE != PLATFORM violation).`);
    }
  }

  if (!planObj.task_id || typeof planObj.task_id !== 'string') {
    throw new Error('[planner_rejected] Task Plan must contain a valid "task_id"');
  }

  if (!Array.isArray(planObj.plan) || planObj.plan.length === 0) {
    throw new Error('[planner_rejected] Task Plan "plan" must be a non-empty array of steps');
  }

  for (let i = 0; i < planObj.plan.length; i++) {
    const step = planObj.plan[i];
    if (!step || typeof step !== 'object') {
      throw new Error(`[planner_rejected] Step ${i + 1} must be an object`);
    }

    // Check forbidden fields at step level
    for (const field of FORBIDDEN_FIELDS) {
      if (field in step) {
        throw new Error(`[planner_rejected] Illegal field "${field}" detected in step ${step.step || i + 1} (ROLE != PLATFORM violation).`);
      }
    }

    if (typeof step.step !== 'number' || step.step < 1) {
      throw new Error(`[planner_rejected] Step ${i + 1} must have a valid positive integer "step"`);
    }

    if (!step.goal || typeof step.goal !== 'string' || !step.goal.trim()) {
      throw new Error(`[planner_rejected] Step ${step.step} must have a non-empty "goal"`);
    }

    if (!step.role || typeof step.role !== 'string' || !ALLOWED_ROLES.includes(step.role)) {
      throw new Error(`[planner_rejected] Step ${step.step} has invalid role "${step.role}". Allowed roles: ${[...ALLOWED_ROLES].join(', ')}`);
    }
  }

  return true;
}

/**
 * Decompose user goal into ordered execution steps
 */
export function generatePlanSteps(goal, context = '') {
  const g = String(goal).toLowerCase();
  const c = String(context).toLowerCase();

  // Domain-aware decomposition heuristic
  if (g.includes('搜索') || g.includes('去重') || g.includes('知识库') || c.includes('知识库')) {
    return [
      {
        step: 1,
        goal: '知识库需求分析与目录结构规划',
        role: 'author',
        description: '梳理知识范围、分类层级与命名规范',
      },
      {
        step: 2,
        goal: '核心内容提取、整理与去重实现',
        role: 'author',
        description: '进行条目去重、结构化格式排版与知识整合',
      },
      {
        step: 3,
        goal: '知识完整性与目录规范性审核',
        role: 'reviewer',
        description: '独立校验条目准确度、无重复项与格式合规性',
      },
    ];
  }

  if (g.includes('修复') || g.includes('bug') || g.includes('fix')) {
    return [
      {
        step: 1,
        goal: '复现缺陷并定位根本原因',
        role: 'author',
        description: '分析错误日志与代码上下文，确认故障逻辑',
      },
      {
        step: 2,
        goal: '实现最小化缺陷修复',
        role: 'author',
        description: '编写修复代码并运行单元测试验证',
      },
      {
        step: 3,
        goal: '代码变更独立代码审查与回归测试',
        role: 'reviewer',
        description: '验证修改未引入副作用，且符合规范',
      },
    ];
  }

  // Standard development lifecycle breakdown
  return [
    {
      step: 1,
      goal: `分析需求与设计方案: ${goal}`,
      role: 'author',
      description: '明确实现边界、依赖关系与技术设计',
    },
    {
      step: 2,
      goal: `实现核心功能与单元测试: ${goal}`,
      role: 'author',
      description: '编写功能代码与配套自动化测试',
    },
    {
      step: 3,
      goal: `代码质量与架构合规独立审核: ${goal}`,
      role: 'reviewer',
      description: '执行静态规则校验与方案完整性验收',
    },
  ];
}

/**
 * Primary entry point: Plan a Task Capsule into a Task Plan
 *
 * @param {Object} capsule - Task Capsule from Gateway
 * @param {Object} [options]
 * @param {string} [options.provider] - Planner provider override (defaults to 'antigravity')
 * @param {Function} [options.planGenerator] - Custom step generator function
 * @returns {Promise<Object>} Task Plan object
 */
export async function planTask(capsule, options = {}) {
  // 1. Validate incoming capsule
  validateTaskCapsule(capsule);

  const provider = options.provider || DEFAULT_PLANNER_PROVIDER;

  // 2. Generate plan steps
  const steps = typeof options.planGenerator === 'function'
    ? await options.planGenerator(capsule)
    : generatePlanSteps(capsule.goal, capsule.context);

  // 3. Assemble task plan object
  const proposal = options.actionProposal || capsule.action_proposal || deriveActionProposal(capsule, { plan: steps });
  if (proposal && !proposal.contract_version) {
    proposal.contract_version = CURRENT_CONTRACT_VERSION;
  }
  const planResult = {
    task_id: capsule.task_id,
    planner_provider: provider,
    summary: `Plan generated for task ${capsule.task_id}: ${capsule.goal}`,
    created_at: new Date().toISOString(),
    plan: steps,
    action_proposal: proposal,
  };

  // 4. Validate output schema & anti-platform invariant
  validateTaskPlan(planResult);

  return planResult;
}

/**
 * Attach generated plan to Task Capsule
 */
export function attachPlanToCapsule(capsule, plan) {
  validateTaskCapsule(capsule);
  validateTaskPlan(plan);
  return {
    state: capsule.state || 'READY',
    ...capsule,
    planner_result: plan,
    action_proposal: plan.action_proposal || capsule.action_proposal || null,
  };
}

