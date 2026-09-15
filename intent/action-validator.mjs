// action-validator.mjs - Agent Foundry Deterministic Action Validator (PHASE 10.1 Hardened)
//
// Invariants:
//   1. LLM output is untrusted. Planner only proposes an Action Proposal.
//   2. Deterministic Validator (pure code) cross-checks proposal against real physical assets.
//   3. Canonical path resolution via realpathSync (AC-H1).
//   4. Action contract versioning strictly validated (AC-H2).
//   5. Fail-closed on missing security fields / unknown assets (AC-H3).
//   6. Structured audit evidence generated deterministically (AC-H4).
//   7. Immutable audit evidence defense against proposal injection (AC-H5).
//   8. Canonical gates: AUTO_ALLOW, WAITING_HUMAN, DENY.
//   9. Pure validation: NO executor calls, NO governance mutations.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTargetAsset,
  TARGET_ASSET_TYPES,
  IMPACT_SCOPES,
} from './asset-classifier.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

export const CURRENT_CONTRACT_VERSION = '1.0';

export const CANONICAL_ACTION_TYPES = Object.freeze([
  'READ',
  'ANALYZE',
  'GENERATE',
  'PATCH_CODE',
  'MODIFY_DOCUMENT',
  'DELETE_ARTIFACT',
  'MODIFY_KNOWLEDGE_STRUCTURE',
  'MODIFY_GOVERNANCE',
  'MODIFY_SYSTEM_CONFIG',
  'DEPLOY_EXTERNAL',
]);

export const GATE_VERDICTS = Object.freeze({
  AUTO_ALLOW: 'AUTO_ALLOW',
  WAITING_HUMAN: 'WAITING_HUMAN',
  DENY: 'DENY',
});

/**
 * Validate syntax and schema of an incoming Action Proposal.
 *
 * @param {object} proposal - The Action Proposal to validate
 * @returns {boolean} true if valid, throws on invalid
 */
export function validateActionProposalSchema(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    throw new Error('[invalid_action_proposal] Action Proposal must be a non-null object');
  }

  if (!proposal.action_type || typeof proposal.action_type !== 'string') {
    throw new Error('[invalid_action_proposal] Action Proposal must contain "action_type"');
  }

  const act = proposal.action_type.trim().toUpperCase();
  if (!CANONICAL_ACTION_TYPES.includes(act)) {
    throw new Error(`[invalid_action_type] Unknown action_type: "${proposal.action_type}". Allowed action types: ${CANONICAL_ACTION_TYPES.join(', ')}`);
  }

  // AC-H2: Contract version validation
  if (proposal.contract_version !== undefined && proposal.contract_version !== null) {
    if (typeof proposal.contract_version !== 'string' || proposal.contract_version !== CURRENT_CONTRACT_VERSION) {
      throw new Error(`[unsupported_contract_version] Unsupported action contract version: "${proposal.contract_version}". Supported version is "${CURRENT_CONTRACT_VERSION}".`);
    }
  }

  if (proposal.target !== undefined && proposal.target !== null && typeof proposal.target !== 'object') {
    throw new Error('[invalid_action_proposal] Action Proposal target must be an object');
  }

  if (proposal.impact !== undefined && proposal.impact !== null && typeof proposal.impact !== 'object') {
    throw new Error('[invalid_action_proposal] Action Proposal impact must be an object');
  }

  return true;
}

/**
 * Derive an initial Action Proposal if one was not explicitly attached by the caller/planner.
 */
export function deriveActionProposal(capsule = {}, plan = null) {
  const goal = String(capsule?.goal || '').toLowerCase();
  const context = String(capsule?.context || '').toLowerCase();
  const combined = `${goal}\n${context}`;
  const targetPath = capsule?.target_path || capsule?.candidate?.target || '';
  const realAsset = classifyTargetAsset(targetPath, capsule);

  // 1. Governance change
  if (
    realAsset.type === TARGET_ASSET_TYPES.GOVERNANCE ||
    combined.includes('schema.md') ||
    combined.includes('index.md') ||
    combined.includes('metadata规则')
  ) {
    return {
      contract_version: CURRENT_CONTRACT_VERSION,
      action_type: 'MODIFY_GOVERNANCE',
      target: realAsset,
      impact: { scope: IMPACT_SCOPES.SYSTEM, reversible: false },
    };
  }

  // 2. System config change
  if (
    realAsset.type === TARGET_ASSET_TYPES.SYSTEM_CONFIG ||
    combined.includes('agents.md') ||
    combined.includes('mcp配置') ||
    combined.includes('executor配置') ||
    combined.includes('scheduler配置')
  ) {
    return {
      contract_version: CURRENT_CONTRACT_VERSION,
      action_type: 'MODIFY_SYSTEM_CONFIG',
      target: realAsset,
      impact: { scope: IMPACT_SCOPES.SYSTEM, reversible: false },
    };
  }

  // 3. Direction / Knowledge structure change
  const planSteps = Array.isArray(plan?.plan) ? plan.plan : [];
  const hasDirectionChange = planSteps.some((st) => {
    const s = String(typeof st === 'string' ? st : (st?.goal || '') + (st?.description || ''));
    return (
      s.includes('重新设计目录') ||
      s.includes('合并分类') ||
      s.includes('删除重复内容') ||
      s.includes('重构目录')
    );
  });

  if (hasDirectionChange || combined.includes('知识库结构')) {
    return {
      contract_version: CURRENT_CONTRACT_VERSION,
      action_type: 'MODIFY_KNOWLEDGE_STRUCTURE',
      target: realAsset,
      impact: { scope: IMPACT_SCOPES.PROJECT, reversible: false },
    };
  }

  // 4. Deletion
  const isDestructive =
    /(大量|批量|不可恢复|永久).*(删除|清空)/.test(combined) ||
    combined.includes('删除知识资产') ||
    combined.includes('删除核心代码');
  const isRoutineCleanup =
    /(清理|清除|clean|删除).*(临时|缓存|cache|tmp|temp)/.test(combined) ||
    combined.includes('清理临时文件') ||
    combined.includes('清理缓存');

  if (isDestructive) {
    return {
      contract_version: CURRENT_CONTRACT_VERSION,
      action_type: 'DELETE_ARTIFACT',
      target: realAsset,
      impact: { scope: IMPACT_SCOPES.PROJECT, reversible: false },
    };
  }

  if (isRoutineCleanup) {
    return {
      contract_version: CURRENT_CONTRACT_VERSION,
      action_type: 'DELETE_ARTIFACT',
      target: { type: TARGET_ASSET_TYPES.TEMP_CACHE, path: '/tmp', scope: IMPACT_SCOPES.LOCAL },
      impact: { scope: IMPACT_SCOPES.LOCAL, reversible: true },
    };
  }

  // 5. External deployment
  if (
    combined.includes('公开发布') ||
    combined.includes('网站上线') ||
    combined.includes('部署上线') ||
    combined.includes('对外发布')
  ) {
    return {
      contract_version: CURRENT_CONTRACT_VERSION,
      action_type: 'DEPLOY_EXTERNAL',
      target: realAsset,
      impact: { scope: IMPACT_SCOPES.SYSTEM, reversible: false },
    };
  }

  // 6. Routine code / document / analysis
  if (realAsset.type === TARGET_ASSET_TYPES.CODE) {
    return {
      contract_version: CURRENT_CONTRACT_VERSION,
      action_type: 'PATCH_CODE',
      target: realAsset,
      impact: { scope: IMPACT_SCOPES.PROJECT, reversible: true },
    };
  }

  return {
    contract_version: CURRENT_CONTRACT_VERSION,
    action_type: 'GENERATE',
    target: realAsset,
    impact: { scope: IMPACT_SCOPES.PROJECT, reversible: true },
  };
}

/**
 * Deterministically validate an Action Proposal and compute the Effective Action & Gate Verdict.
 *
 * @param {object|null} proposal - The Action Proposal from Planner (or null)
 * @param {object} capsule - The Task Capsule
 * @param {object|null} plan - The execution plan (or null)
 * @returns {object} Canonical Effective Action object
 */
export function validateAndComputeEffectiveAction(proposal = null, capsule = {}, plan = null) {
  const effectiveProposal = proposal || capsule?.action_proposal || deriveActionProposal(capsule, plan);

  // 1. Schema check & AC-H2 fail-closed version check
  let versionRejected = false;
  let versionRejectReason = null;
  try {
    validateActionProposalSchema(effectiveProposal);
  } catch (err) {
    if (err.message && err.message.includes('unsupported_contract_version')) {
      versionRejected = true;
      versionRejectReason = err.message;
    } else {
      throw err;
    }
  }

  const rawAction = (effectiveProposal.action_type || 'GENERATE').trim().toUpperCase();
  const declaredTarget = effectiveProposal.target || {};
  const declaredImpact = effectiveProposal.impact || {};

  // AC-H5: Audit Evidence Immutability / Proposal Injection Defense
  // Quarantines caller-supplied proposal evidence so it cannot pollute authoritative audit_evidence
  let untrustedProposalEvidence = null;
  if (effectiveProposal.audit_evidence !== undefined && effectiveProposal.audit_evidence !== null) {
    untrustedProposalEvidence = Array.isArray(effectiveProposal.audit_evidence)
      ? effectiveProposal.audit_evidence
      : [effectiveProposal.audit_evidence];
  }

  // 2. Scan real physical asset via canonical path resolution (AC-H1)
  const targetPath = capsule?.target_path || declaredTarget?.path || capsule?.candidate?.target || '';
  const realAsset = classifyTargetAsset(targetPath, capsule);

  // Authoritative audit evidence generated deterministically by pure code (AC-H4)
  const auditEvidence = [];
  if (Array.isArray(realAsset.evidence)) {
    auditEvidence.push(...realAsset.evidence);
  }

  let finalAction = rawAction;
  let escalated = false;
  let escalationReason = null;

  // -------------------------------------------------------------------------
  // AC-H2 Fail-Closed: Unsupported Version
  // -------------------------------------------------------------------------
  if (versionRejected) {
    escalated = true;
    escalationReason = versionRejectReason;
    auditEvidence.push({
      rule: 'FAIL_CLOSED_UNSUPPORTED_VERSION',
      evidence: versionRejectReason,
      source: 'action-validator',
    });
  }

  // -------------------------------------------------------------------------
  // AC-H3 Fail-Closed: Missing or non-boolean impact.reversible
  // -------------------------------------------------------------------------
  const rawReversible = declaredImpact?.reversible;
  const isReversibleValid = typeof rawReversible === 'boolean';
  let finalReversible = isReversibleValid ? rawReversible : false;

  if (!isReversibleValid) {
    escalated = true;
    const reason = 'Missing or invalid impact.reversible: fail-closed escalated to irreversible (WAITING_HUMAN)';
    escalationReason = escalationReason ? `${escalationReason}; ${reason}` : reason;
    auditEvidence.push({
      rule: 'FAIL_CLOSED_MISSING_REVERSIBLE',
      evidence: `impact.reversible is ${rawReversible === undefined ? 'missing' : typeof rawReversible}, fail-closed escalated to irreversible`,
      source: 'action-validator',
    });
  }

  // -------------------------------------------------------------------------
  // AC-H3 Fail-Closed: Missing or unknown impact.scope
  // -------------------------------------------------------------------------
  const rawScope = declaredImpact?.scope;
  const isScopeValid = typeof rawScope === 'string' && Object.values(IMPACT_SCOPES).includes(rawScope);
  let finalScope;

  if (!isScopeValid) {
    finalScope = IMPACT_SCOPES.SYSTEM;
    escalated = true;
    const reason = 'Missing or unknown impact.scope: escalated to SYSTEM (WAITING_HUMAN)';
    escalationReason = escalationReason ? `${escalationReason}; ${reason}` : reason;
    auditEvidence.push({
      rule: 'FAIL_CLOSED_UNKNOWN_IMPACT_SCOPE',
      evidence: `impact.scope is '${rawScope}', escalated to SYSTEM`,
      source: 'action-validator',
    });
  } else {
    finalScope = realAsset.scope || rawScope;
  }

  // -------------------------------------------------------------------------
  // AC-H3 Fail-Closed: Missing or unknown target.type
  // -------------------------------------------------------------------------
  const rawTargetType = declaredTarget?.type;
  const isDeclaredTargetValid = typeof rawTargetType === 'string' && Object.values(TARGET_ASSET_TYPES).includes(rawTargetType);
  let finalTargetType;

  if (!isDeclaredTargetValid) {
    finalTargetType = 'UNKNOWN';
    escalated = true;
    const reason = 'Missing or unknown target.type: fail-closed escalated to WAITING_HUMAN';
    escalationReason = escalationReason ? `${escalationReason}; ${reason}` : reason;
    auditEvidence.push({
      rule: 'FAIL_CLOSED_UNKNOWN_TARGET_TYPE',
      evidence: `target.type '${rawTargetType}' is invalid or missing, fail-closed escalated to WAITING_HUMAN`,
      source: 'action-validator',
    });
  } else {
    finalTargetType = realAsset.type || rawTargetType;
  }

  let finalTarget = {
    type: finalTargetType,
    path: realAsset.path || declaredTarget.path || 'workspace',
    scope: finalScope,
  };

  let finalImpact = {
    scope: finalScope,
    reversible: finalReversible,
  };

  // -------------------------------------------------------------------------
  // Privilege Escalation Check 1: Real asset is GOVERNANCE (AC-H1 symlink aware)
  // E.g. Planner claims READ or MODIFY_DOCUMENT but target touches SCHEMA.md
  // -------------------------------------------------------------------------
  if (realAsset.type === TARGET_ASSET_TYPES.GOVERNANCE) {
    finalTarget.type = TARGET_ASSET_TYPES.GOVERNANCE;
    finalTarget.scope = IMPACT_SCOPES.SYSTEM;
    finalImpact.scope = IMPACT_SCOPES.SYSTEM;
    finalImpact.reversible = false;

    if (rawAction !== 'MODIFY_GOVERNANCE') {
      escalated = true;
      const reason = `Planner declared ${rawAction} but target touches governance asset (${realAsset.path})`;
      escalationReason = escalationReason ? `${escalationReason}; ${reason}` : reason;
      finalAction = 'MODIFY_GOVERNANCE';
      auditEvidence.push({
        rule: 'PRIVILEGE_ESCALATION_GOVERNANCE',
        evidence: reason,
        source: 'action-validator',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Privilege Escalation Check 2: Real asset is SYSTEM_CONFIG
  // E.g. Planner claims non-config action but target touches AGENTS.md / mcp
  // -------------------------------------------------------------------------
  if (realAsset.type === TARGET_ASSET_TYPES.SYSTEM_CONFIG) {
    finalTarget.type = TARGET_ASSET_TYPES.SYSTEM_CONFIG;
    finalTarget.scope = IMPACT_SCOPES.SYSTEM;
    finalImpact.scope = IMPACT_SCOPES.SYSTEM;
    finalImpact.reversible = false;

    if (rawAction !== 'MODIFY_SYSTEM_CONFIG') {
      escalated = true;
      const reason = `Planner declared ${rawAction} but target touches system configuration asset (${realAsset.path})`;
      escalationReason = escalationReason ? `${escalationReason}; ${reason}` : reason;
      finalAction = 'MODIFY_SYSTEM_CONFIG';
      auditEvidence.push({
        rule: 'PRIVILEGE_ESCALATION_SYSTEM_CONFIG',
        evidence: reason,
        source: 'action-validator',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Privilege Escalation Check 3: Real asset is VAULT with irreversible impact
  // E.g. DELETE on VAULT cannot be treated as local temp cleanup
  // -------------------------------------------------------------------------
  if (finalAction === 'DELETE_ARTIFACT') {
    if (finalTarget.type === TARGET_ASSET_TYPES.VAULT || declaredTarget.type === TARGET_ASSET_TYPES.VAULT) {
      finalTarget.type = TARGET_ASSET_TYPES.VAULT;
      finalImpact.reversible = false;
      finalImpact.scope = IMPACT_SCOPES.PROJECT;
      if (!escalated && declaredImpact?.reversible === true) {
        escalated = true;
        escalationReason = 'Deletion on vault knowledge assets is irreversible';
        auditEvidence.push({
          rule: 'PRIVILEGE_ESCALATION_VAULT_DELETE',
          evidence: escalationReason,
          source: 'action-validator',
        });
      }
    } else if (finalTarget.type === TARGET_ASSET_TYPES.TEMP_CACHE) {
      if (isReversibleValid && rawReversible === true) {
        finalImpact.reversible = true;
        finalImpact.scope = IMPACT_SCOPES.LOCAL;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Gate Verdict Calculation (Deterministic Action Matrix + Fail-Closed)
  // -------------------------------------------------------------------------
  let requiredGate = GATE_VERDICTS.AUTO_ALLOW;

  if (versionRejected) {
    requiredGate = GATE_VERDICTS.WAITING_HUMAN;
  } else if (!isReversibleValid) {
    // AC-H3 Rule 1: Missing/invalid reversible MUST be WAITING_HUMAN
    requiredGate = GATE_VERDICTS.WAITING_HUMAN;
  } else if (!isScopeValid) {
    // AC-H3 Rule 2: Missing/invalid scope MUST be WAITING_HUMAN
    requiredGate = GATE_VERDICTS.WAITING_HUMAN;
  } else if (!isDeclaredTargetValid || finalTargetType === 'UNKNOWN') {
    // AC-H3 Rule 3: Missing/unknown target type MUST be WAITING_HUMAN
    requiredGate = GATE_VERDICTS.WAITING_HUMAN;
  } else {
    switch (finalAction) {
      case 'MODIFY_GOVERNANCE':
      case 'MODIFY_SYSTEM_CONFIG':
      case 'MODIFY_KNOWLEDGE_STRUCTURE':
      case 'DEPLOY_EXTERNAL':
        requiredGate = GATE_VERDICTS.WAITING_HUMAN;
        break;

      case 'DELETE_ARTIFACT':
        // DELETE on TEMP_CACHE with verified reversible=true is AUTO_ALLOW; all others WAITING_HUMAN
        if (finalTarget.type === TARGET_ASSET_TYPES.TEMP_CACHE && finalImpact.reversible === true) {
          requiredGate = GATE_VERDICTS.AUTO_ALLOW;
        } else {
          requiredGate = GATE_VERDICTS.WAITING_HUMAN;
        }
        break;

      case 'READ':
      case 'ANALYZE':
      case 'GENERATE':
      case 'PATCH_CODE':
      case 'MODIFY_DOCUMENT':
        requiredGate = GATE_VERDICTS.AUTO_ALLOW;
        break;

      default:
        requiredGate = GATE_VERDICTS.WAITING_HUMAN;
    }
  }

  // AC-H4: Ensure every WAITING_HUMAN verdict has at least one audit evidence entry
  if (requiredGate === GATE_VERDICTS.WAITING_HUMAN && auditEvidence.length === 0) {
    auditEvidence.push({
      rule: 'ACTION_POLICY_GATE',
      evidence: `Action ${finalAction} requires human confirmation under zero-trust policy`,
      source: 'action-validator',
    });
  }

  const effectiveAction = {
    contract_version: CURRENT_CONTRACT_VERSION,
    action_type: finalAction,
    target: finalTarget,
    impact: finalImpact,
    required_gate: requiredGate,
    audit_evidence: auditEvidence,
    escalated,
    escalation_reason: escalationReason,
    evaluated_at: new Date().toISOString(),
  };

  if (untrustedProposalEvidence) {
    effectiveAction.untrusted_proposal_evidence = untrustedProposalEvidence;
  }

  return effectiveAction;
}
