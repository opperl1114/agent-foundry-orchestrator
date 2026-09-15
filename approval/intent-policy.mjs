// intent-policy.mjs - Agent Foundry Human Intent Alignment Policy (PHASE 9-D)
//
// Invariants:
//   1. AI execution does NOT automatically start when direction changes, system config,
//      knowledge governance, destructive deletions, or external releases are involved.
//   2. Routine generation, analysis, design, and temp-cleanup tasks auto-allow.
//   3. Fail-closed: unhandled evaluations or ambiguity require human confirmation.
//   4. Pure evaluation: NO executor invocation, NO governance mutation, NO database.

export const INTENT_STATUSES = Object.freeze({
  AUTO_ALLOWED: 'AUTO_ALLOWED',
  PENDING_HUMAN: 'PENDING_HUMAN',
  APPROVED: 'APPROVED',
  CANCELLED: 'CANCELLED',
});

export const INTENT_REASONS = Object.freeze({
  ROUTINE_TASK: 'routine_task',
  ROUTINE_CLEANUP: 'routine_cleanup',
  DIRECTION_CONFIRMATION: 'direction_confirmation',
  KNOWLEDGE_GOVERNANCE_CHANGE: 'knowledge_governance_change',
  SYSTEM_CONFIG_CHANGE: 'system_config_change',
  DESTRUCTIVE_DELETION: 'destructive_deletion',
  EXTERNAL_RELEASE: 'external_release',
  POLICY_EVALUATION_ERROR: 'policy_evaluation_error',
});

/**
 * Extract all text content from task capsule and plan for policy inspection.
 */
function extractCorpus(capsule = {}, plan = null) {
  const pieces = [];

  if (capsule?.goal) pieces.push(String(capsule.goal));
  if (capsule?.context) pieces.push(String(capsule.context));
  if (capsule?.target_path) pieces.push(String(capsule.target_path));
  if (capsule?.candidate?.target) pieces.push(String(capsule.candidate.target));
  if (capsule?.task_mode) pieces.push(String(capsule.task_mode));
  if (capsule?.acceptance) pieces.push(String(capsule.acceptance));
  if (Array.isArray(capsule?.red_lines)) {
    pieces.push(...capsule.red_lines.map(String));
  }

  // Extract plan steps
  const planObj = plan || capsule?.planner_result || null;
  const planSteps = [];

  if (planObj) {
    if (Array.isArray(planObj.plan)) {
      for (const item of planObj.plan) {
        if (typeof item === 'string') {
          pieces.push(item);
          planSteps.push(item);
        } else if (item && typeof item === 'object') {
          if (item.goal) {
            pieces.push(String(item.goal));
            planSteps.push(String(item.goal));
          }
          if (item.description) {
            pieces.push(String(item.description));
            planSteps.push(String(item.description));
          }
        }
      }
    }
    if (Array.isArray(planObj.steps)) {
      for (const item of planObj.steps) {
        if (typeof item === 'string') {
          pieces.push(item);
          planSteps.push(item);
        } else if (item && typeof item === 'object') {
          if (item.goal) pieces.push(String(item.goal));
          if (item.description) pieces.push(String(item.description));
        }
      }
    }
    if (planObj.summary) pieces.push(String(planObj.summary));
  }

  return {
    fullText: pieces.join('\n'),
    planSteps,
    targetPath: String(capsule?.target_path || capsule?.candidate?.target || '').trim(),
    goal: String(capsule?.goal || '').trim(),
    context: String(capsule?.context || '').trim(),
  };
}

/**
 * Evaluate Intent Alignment Policy for a given task capsule and execution plan.
 *
 * @param {object} capsule - The Task Capsule
 * @param {object|null} plan - The generated plan (or null)
 * @returns {{ required: boolean, reason: string, description: string, status: string }}
 */
export function evaluateIntentPolicy(capsule = {}, plan = null) {
  try {
    const { fullText, planSteps, targetPath, goal } = extractCorpus(capsule, plan);
    const lower = fullText.toLowerCase();

    // -------------------------------------------------------------------------
    // Rule 1: 方向确认 (AI Planning Direction Confirmation)
    // -------------------------------------------------------------------------
    // If the AI Planner suggests structural reorganization, restructuring
    // directories, or merging categories not explicitly mandated, require human confirmation.
    const directionKeywords = [
      '重新设计目录',
      '合并分类',
      '删除重复内容',
      '重构目录',
      '调整结构',
      '重组分类',
      '合并目录',
      '结构重组',
      '重新规划目录',
      '改变知识组织方式',
      '分类重组',
      'redesign directory',
      'merge categories',
      'restructure directory',
    ];

    const planHasDirectionChange = planSteps.some((step) => {
      const stepStr = String(step);
      return directionKeywords.some((kw) => stepStr.includes(kw));
    });

    if (planHasDirectionChange) {
      return {
        required: true,
        reason: INTENT_REASONS.DIRECTION_CONFIRMATION,
        description: 'AI planning direction change requires human confirmation (directory restructuring / category merging proposed)',
        status: INTENT_STATUSES.PENDING_HUMAN,
      };
    }

    // -------------------------------------------------------------------------
    // Rule 2: 知识治理变化 (Knowledge Governance Change)
    // -------------------------------------------------------------------------
    // Touches SCHEMA.md, index rules, metadata rules, or knowledge vault structure
    const isGovTarget = /schema\.md/i.test(targetPath) ||
      /index\.md/i.test(targetPath) ||
      /metadata/i.test(targetPath) ||
      /knowledge-vault/i.test(targetPath);

    const govKeywords = [
      '修改知识库目录结构',
      '修改schema',
      '修改index规则',
      '修改metadata规则',
      '改变知识组织方式',
      'schema.md',
      'index.md',
      'metadata规则',
      '知识库结构',
      '知识治理规则',
      'modify schema',
      'update index rules',
      'update metadata rules',
    ];

    const hasGovKeywords = govKeywords.some((kw) => lower.includes(kw.toLowerCase()));

    if (isGovTarget || hasGovKeywords) {
      return {
        required: true,
        reason: INTENT_REASONS.KNOWLEDGE_GOVERNANCE_CHANGE,
        description: 'Modifications to knowledge governance, schemas, index rules, or metadata require human confirmation',
        status: INTENT_STATUSES.PENDING_HUMAN,
      };
    }

    // -------------------------------------------------------------------------
    // Rule 3: 系统配置变化 (System Configuration Change)
    // -------------------------------------------------------------------------
    // Touches AGENTS.md, MCP configuration, Executor configuration, Scheduler configuration, or runtime rules
    const isSysConfigTarget = /agents\.md/i.test(targetPath) ||
      /scheduler\.json/i.test(targetPath) ||
      /executors?/i.test(targetPath) ||
      /mcp/i.test(targetPath) ||
      /runtime-guard/i.test(targetPath);

    const sysConfigKeywords = [
      '修改agents.md',
      '修改mcp配置',
      '修改executor配置',
      '修改scheduler配置',
      '修改运行规则',
      'agents.md',
      'mcp配置',
      'executor配置',
      'scheduler配置',
      '系统配置修改',
      'modify agents.md',
      'modify mcp config',
      'modify executor config',
      'system config change',
    ];

    const hasSysConfigKeywords = sysConfigKeywords.some((kw) => lower.includes(kw.toLowerCase()));

    if (isSysConfigTarget || hasSysConfigKeywords) {
      return {
        required: true,
        reason: INTENT_REASONS.SYSTEM_CONFIG_CHANGE,
        description: 'Modifications to system configuration (AGENTS.md, MCP, Executor, Scheduler, or runtime rules) require human confirmation',
        status: INTENT_STATUSES.PENDING_HUMAN,
      };
    }

    // -------------------------------------------------------------------------
    // Rule 4: 删除操作 (Deletion Operations)
    // -------------------------------------------------------------------------
    // Routine temp/cache cleanups are allowed automatically;
    // Bulk/destructive deletions require human confirmation.
    const isDestructive = /(大量|批量|不可恢复|永久|bulk|permanent|recursive|rm\s+-rf).*(删除|清空|delete)/i.test(fullText) ||
      /(删除|清空|delete).*(大量|批量|不可恢复|永久|知识资产|知识库内容|项目核心|核心代码|core file|knowledge asset)/i.test(fullText) ||
      /删除知识资产|删除知识库内容|删除项目核心文件|删除核心代码|大量删除/i.test(fullText);

    if (isDestructive) {
      return {
        required: true,
        reason: INTENT_REASONS.DESTRUCTIVE_DELETION,
        description: 'Destructive, bulk, or permanent deletion operations require human confirmation',
        status: INTENT_STATUSES.PENDING_HUMAN,
      };
    }

    const isRoutineCleanup = /(清理|清除|clean|delete|删除).*(临时|缓存|cache|tmp|temp)/i.test(fullText) ||
      /(临时|缓存|cache|tmp|temp).*(清理|清除|cleanup)/i.test(fullText) ||
      /clean tmp|clean cache|clean temp|temporary file cleanup/i.test(fullText);

    if (isRoutineCleanup) {
      return {
        required: false,
        reason: INTENT_REASONS.ROUTINE_CLEANUP,
        description: 'Routine temporary or cache cleanup is auto-allowed',
        status: INTENT_STATUSES.AUTO_ALLOWED,
      };
    }

    // -------------------------------------------------------------------------
    // Rule 5: 发布操作 (Release Operations)
    // -------------------------------------------------------------------------
    // External releases (public publish, deployment, website launch) require confirmation.
    // Internal draft generations do not.
    const isInternalDraft = lower.includes('内部草稿生成') ||
      lower.includes('草稿') ||
      lower.includes('draft') ||
      lower.includes('internal draft');

    const externalReleaseKeywords = [
      '公开发布',
      '网站上线',
      '部署上线',
      '对外发布',
      '发布版本',
      'production release',
      'deploy to production',
      'public publish',
    ];

    const hasExternalRelease = externalReleaseKeywords.some((kw) => lower.includes(kw.toLowerCase())) ||
      (/\brelease\b/i.test(fullText) && !isInternalDraft);

    if (hasExternalRelease && !isInternalDraft) {
      return {
        required: true,
        reason: INTENT_REASONS.EXTERNAL_RELEASE,
        description: 'External release, public publishing, or production deployment requires human confirmation',
        status: INTENT_STATUSES.PENDING_HUMAN,
      };
    }

    // -------------------------------------------------------------------------
    // Rule 6: 普通生成任务 (Routine Generation Tasks)
    // -------------------------------------------------------------------------
    // Routine documentation generation, code analysis, proposal design, information organization
    return {
      required: false,
      reason: INTENT_REASONS.ROUTINE_TASK,
      description: 'Routine generation, analysis, design, or information organization task is auto-allowed',
      status: INTENT_STATUSES.AUTO_ALLOWED,
    };
  } catch (err) {
    // Fail closed
    return {
      required: true,
      reason: INTENT_REASONS.POLICY_EVALUATION_ERROR,
      description: `Policy evaluation encountered an error: ${err.message}`,
      status: INTENT_STATUSES.PENDING_HUMAN,
    };
  }
}
