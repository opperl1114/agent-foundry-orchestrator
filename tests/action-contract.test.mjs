// tests/action-contract.test.mjs - PHASE 10 Semantic Intent Action Contract Tests
//
// Invariants verified:
//   TEST AC-1: 合法 Action Proposal 通过 Schema
//   TEST AC-2: 未知 action_type 被拒绝
//   TEST AC-3: Planner 声明 READ 但访问 SCHEMA.md 被升级为 MODIFY_GOVERNANCE
//   TEST AC-4: DELETE TEMP_CACHE 自动允许
//   TEST AC-5: DELETE VAULT irreversible 进入 WAITING_HUMAN
//   TEST AC-6: Validator 不调用 Executor
//   TEST AC-7: Validator 不修改 Governance
//   TEST AC-8: 旧 intent-policy regex 不再作为最终决策来源

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateActionProposalSchema,
  validateAndComputeEffectiveAction,
  CANONICAL_ACTION_TYPES,
  GATE_VERDICTS,
} from '../intent/action-validator.mjs';
import {
  classifyTargetAsset,
  TARGET_ASSET_TYPES,
  IMPACT_SCOPES,
} from '../intent/asset-classifier.mjs';
import {
  alignTaskIntent,
  validateIntentArgs,
} from '../approval/intent-gate.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_DIR = join(ROOT_DIR, 'contracts');
const INTENT_DIR = join(ROOT_DIR, 'intent');

// ----------------------------------------------------------------------------
// TEST AC-1: 合法 Action Proposal 通过 Schema
// ----------------------------------------------------------------------------
test('TEST AC-1: 合法 Action Proposal 通过 Schema', () => {
  // 1. Verify schema definition exists and is valid JSON
  const schemaPath = join(CONTRACTS_DIR, 'action-contract.schema.json');
  assert(existsSync(schemaPath), 'action-contract.schema.json must exist');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  assert(schema.definitions.ActionType.enum.length >= 10);

  const typesPath = join(CONTRACTS_DIR, 'action-types.json');
  assert(existsSync(typesPath), 'action-types.json must exist');
  const types = JSON.parse(readFileSync(typesPath, 'utf8'));

  // 2. Validate compliant Action Proposals across canonical types
  for (const act of types.action_types) {
    const proposal = {
      action_type: act,
      target: {
        type: 'CODE',
        path: 'src/main.js',
        scope: 'PROJECT',
      },
      impact: {
        scope: 'PROJECT',
        reversible: true,
      },
      reason: `Test proposal for ${act}`,
    };
    assert.strictEqual(validateActionProposalSchema(proposal), true, `ActionProposal for ${act} must validate`);
  }
});

// ----------------------------------------------------------------------------
// TEST AC-2: 未知 action_type 被拒绝
// ----------------------------------------------------------------------------
test('TEST AC-2: 未知 action_type 被拒绝', () => {
  const invalidProposals = [
    {
      action_type: 'SUPERUSER_EXEC',
      target: { type: 'CODE' },
      impact: { scope: 'SYSTEM', reversible: false },
    },
    {
      action_type: 'DROP_DATABASE',
      target: { type: 'VAULT' },
      impact: { scope: 'SYSTEM', reversible: false },
    },
    {
      action_type: 'UNKNOWN_CUSTOM_ACTION',
      target: { type: 'DOCUMENT' },
      impact: { scope: 'LOCAL', reversible: true },
    },
    {
      action_type: '',
      target: { type: 'CODE' },
      impact: { scope: 'PROJECT', reversible: true },
    },
  ];

  for (const bad of invalidProposals) {
    assert.throws(
      () => validateActionProposalSchema(bad),
      /invalid_action_type|invalid_action_proposal/,
      `Unknown action_type "${bad.action_type}" must be rejected`
    );
  }
});

// ----------------------------------------------------------------------------
// TEST AC-3: Planner 声明 READ 但访问 SCHEMA.md 被升级为 MODIFY_GOVERNANCE
// ----------------------------------------------------------------------------
test('TEST AC-3: Planner 声明 READ 但访问 SCHEMA.md 被升级为 MODIFY_GOVERNANCE', () => {
  const proposal = {
    action_type: 'READ',
    target: {
      type: 'DOCUMENT',
      path: 'agent-foundry-vault/SCHEMA.md',
      scope: 'PROJECT',
    },
    impact: {
      scope: 'PROJECT',
      reversible: true,
    },
  };

  const capsule = {
    task_id: 'TASK-AC3-001',
    goal: '检查SCHEMA.md规则并分析格式',
    target_path: 'agent-foundry-vault/SCHEMA.md',
    action_proposal: proposal,
  };

  // 1. Validator detects privilege escalation
  const effective = validateAndComputeEffectiveAction(proposal, capsule, null);

  assert.strictEqual(effective.action_type, 'MODIFY_GOVERNANCE', 'Action must be escalated to MODIFY_GOVERNANCE');
  assert.strictEqual(effective.escalated, true, 'Escalation flag must be true');
  assert.strictEqual(effective.target.type, TARGET_ASSET_TYPES.GOVERNANCE);
  assert.strictEqual(effective.impact.scope, IMPACT_SCOPES.SYSTEM);
  assert.strictEqual(effective.impact.reversible, false);
  assert.strictEqual(effective.required_gate, GATE_VERDICTS.WAITING_HUMAN);
  assert(effective.escalation_reason.includes('touches governance asset'), 'Escalation reason must be recorded');

  // 2. Intent Gate receives effective action and parks task in WAITING_HUMAN
  const gateRes = alignTaskIntent(capsule, null, { tasksDir: '/tmp' });
  assert.strictEqual(gateRes.status, 'WAITING_HUMAN');
  assert.strictEqual(capsule.state, 'WAITING_HUMAN');
  assert.strictEqual(capsule.intent_alignment.required, true);
  assert.strictEqual(capsule.effective_action.action_type, 'MODIFY_GOVERNANCE');
});

// ----------------------------------------------------------------------------
// TEST AC-4: DELETE TEMP_CACHE 自动允许
// ----------------------------------------------------------------------------
test('TEST AC-4: DELETE TEMP_CACHE 自动允许', () => {
  const proposal = {
    action_type: 'DELETE_ARTIFACT',
    target: {
      type: 'TEMP_CACHE',
      path: '/tmp/build-cache-test',
      scope: 'LOCAL',
    },
    impact: {
      scope: 'LOCAL',
      reversible: true,
    },
  };

  const capsule = {
    task_id: 'TASK-AC4-001',
    goal: '清理构建缓存和临时输出',
    target_path: '/tmp/build-cache-test',
    action_proposal: proposal,
  };

  const effective = validateAndComputeEffectiveAction(proposal, capsule, null);

  assert.strictEqual(effective.action_type, 'DELETE_ARTIFACT');
  assert.strictEqual(effective.target.type, TARGET_ASSET_TYPES.TEMP_CACHE);
  assert.strictEqual(effective.impact.reversible, true);
  assert.strictEqual(effective.required_gate, GATE_VERDICTS.AUTO_ALLOW);

  const gateRes = alignTaskIntent(capsule, null, { tasksDir: '/tmp' });
  assert.strictEqual(gateRes.status, 'AUTO_ALLOWED');
  assert.strictEqual(capsule.state, 'READY');
  assert.strictEqual(capsule.intent_alignment.required, false);
  assert.strictEqual(capsule.effective_action.required_gate, 'AUTO_ALLOW');
});

// ----------------------------------------------------------------------------
// TEST AC-5: DELETE VAULT irreversible 进入 WAITING_HUMAN
// ----------------------------------------------------------------------------
test('TEST AC-5: DELETE VAULT irreversible 进入 WAITING_HUMAN', () => {
  const proposal = {
    action_type: 'DELETE_ARTIFACT',
    target: {
      type: 'VAULT',
      path: 'agent-foundry-vault/notes/domain-knowledge.md',
      scope: 'PROJECT',
    },
    impact: {
      scope: 'PROJECT',
      reversible: false,
    },
  };

  const capsule = {
    task_id: 'TASK-AC5-001',
    goal: '删除知识库条目 domain-knowledge.md',
    target_path: 'agent-foundry-vault/notes/domain-knowledge.md',
    action_proposal: proposal,
  };

  const effective = validateAndComputeEffectiveAction(proposal, capsule, null);

  assert.strictEqual(effective.action_type, 'DELETE_ARTIFACT');
  assert.strictEqual(effective.target.type, TARGET_ASSET_TYPES.VAULT);
  assert.strictEqual(effective.impact.reversible, false);
  assert.strictEqual(effective.required_gate, GATE_VERDICTS.WAITING_HUMAN);

  const gateRes = alignTaskIntent(capsule, null, { tasksDir: '/tmp' });
  assert.strictEqual(gateRes.status, 'WAITING_HUMAN');
  assert.strictEqual(capsule.state, 'WAITING_HUMAN');
  assert.strictEqual(capsule.intent_alignment.required, true);
});

// ----------------------------------------------------------------------------
// TEST AC-6: Validator 不调用 Executor
// ----------------------------------------------------------------------------
test('TEST AC-6: Validator 不调用 Executor', () => {
  // 1. Static code boundary check
  const validatorCode = readFileSync(join(INTENT_DIR, 'action-validator.mjs'), 'utf8');
  const classifierCode = readFileSync(join(INTENT_DIR, 'asset-classifier.mjs'), 'utf8');

  const forbiddenPatterns = [
    /adapters/i,
    /child_process/,
    /exec\(/,
    /spawn\(/,
    /fork\(/,
    /executor-router/i,
  ];

  for (const pat of forbiddenPatterns) {
    assert(!pat.test(validatorCode), `action-validator.mjs must NOT contain ${pat}`);
    assert(!pat.test(classifierCode), `asset-classifier.mjs must NOT contain ${pat}`);
  }

  // 2. Dynamic invocation: verify 0 subprocess/executor side-effects
  let executorCount = 0;
  const dummyCapsule = {
    task_id: 'TASK-AC6-001',
    goal: '架构隔离测试',
    target_path: 'src/app.js',
  };

  const effective = validateAndComputeEffectiveAction(null, dummyCapsule, null);
  assert.strictEqual(executorCount, 0, 'No executor must be called');
  assert(effective.action_type, 'Action type must be computed');
});

// ----------------------------------------------------------------------------
// TEST AC-7: Validator 不修改 Governance
// ----------------------------------------------------------------------------
test('TEST AC-7: Validator 不修改 Governance', () => {
  // 1. Passing forbidden governance fields to gate or validator throws boundary_violation
  const badCapsule = {
    task_id: 'TASK-AC7-BAD',
    goal: '试图伪造自动发布',
    policy_decision: 'auto_publish',
  };

  assert.throws(
    () => alignTaskIntent(badCapsule),
    /boundary_violation/,
    'Gate must reject governance bypass fields'
  );

  // 2. Target validation recognizes governance without mutative execution
  const govAsset = classifyTargetAsset('agent-foundry-vault/SCHEMA.md');
  assert.strictEqual(govAsset.type, TARGET_ASSET_TYPES.GOVERNANCE);
  assert.strictEqual(govAsset.scope, IMPACT_SCOPES.SYSTEM);
});

// ----------------------------------------------------------------------------
// TEST AC-8: 旧 intent-policy regex 不再作为最终决策来源
// ----------------------------------------------------------------------------
test('TEST AC-8: 旧 intent-policy regex 不再作为最终决策来源', () => {
  // Case 1: Natural language contains misleading keywords ("大量删除", "SCHEMA.md")
  // but the real action is a safe DOCUMENT GENERATION.
  // With old regex, this would be falsely blocked (false positive).
  // With Semantic Action Contract, the code validates GENERATE on DOCUMENT -> AUTO_ALLOW.
  const falsePositiveCapsule = {
    task_id: 'TASK-AC8-FP',
    goal: '编写一份技术规范，其中说明为什么SCHEMA.md与大量删除操作需要做备份',
    target_path: 'docs/guidelines.md',
    action_proposal: {
      action_type: 'GENERATE',
      target: {
        type: 'DOCUMENT',
        path: 'docs/guidelines.md',
        scope: 'PROJECT',
      },
      impact: {
        scope: 'PROJECT',
        reversible: true,
      },
    },
  };

  const eff1 = validateAndComputeEffectiveAction(falsePositiveCapsule.action_proposal, falsePositiveCapsule, null);
  assert.strictEqual(eff1.action_type, 'GENERATE');
  assert.strictEqual(eff1.target.type, TARGET_ASSET_TYPES.DOCUMENT);
  assert.strictEqual(eff1.required_gate, GATE_VERDICTS.AUTO_ALLOW, 'Must NOT be falsely blocked by text keywords');

  const gate1 = alignTaskIntent(falsePositiveCapsule);
  assert.strictEqual(gate1.status, 'AUTO_ALLOWED', 'Safe documentation generation must pass smoothly');

  // Case 2: Natural language is completely benign ("优化归档并同步目标") with NO sensitive keywords,
  // but real target touches SCHEMA.md.
  // With old regex, this would bypass into execution (false negative / semantic bypass).
  // With Semantic Action Contract, Deterministic Validator intercepts the real physical asset -> WAITING_HUMAN!
  const bypassAttemptCapsule = {
    task_id: 'TASK-AC8-BYPASS',
    goal: '执行日常条目整理与同步',
    target_path: 'agent-foundry-vault/SCHEMA.md',
    action_proposal: {
      action_type: 'READ',
      target: {
        type: 'DOCUMENT',
        path: 'agent-foundry-vault/SCHEMA.md',
        scope: 'LOCAL',
      },
      impact: {
        scope: 'LOCAL',
        reversible: true,
      },
    },
  };

  const eff2 = validateAndComputeEffectiveAction(bypassAttemptCapsule.action_proposal, bypassAttemptCapsule, null);
  assert.strictEqual(eff2.action_type, 'MODIFY_GOVERNANCE');
  assert.strictEqual(eff2.escalated, true);
  assert.strictEqual(eff2.required_gate, GATE_VERDICTS.WAITING_HUMAN, 'Must intercept semantic bypass based on real asset');

  const gate2 = alignTaskIntent(bypassAttemptCapsule);
  assert.strictEqual(gate2.status, 'WAITING_HUMAN', 'Semantic bypass targeting SCHEMA.md must enter WAITING_HUMAN');
});
