// intent-gate.mjs - Agent Foundry Human Intent Alignment Gate (PHASE 9-D)
//
// Invariants:
//   1. Human Intent Alignment Gate establishes a confirmation boundary between Planning and Scheduling.
//   2. Does NOT replace Scheduler: Scheduler retains full ownership over state, lifecycle, and recovery.
//   3. Approval Gate only decides: is execution allowed to start?
//   4. States: READY -> PLANNING -> WAITING_HUMAN -> APPROVED -> AUTHOR_RUNNING (or CANCELLED).
//   5. NO database: all intent records are written directly into Task Capsule (tasks/<task_id>.json).
//   6. Safety Boundary:
//      - CANNOT select executor
//      - CANNOT invoke AGY / Claude / Codex / adapters
//      - CANNOT modify governance results (vault-mcp owns governance)
//      - CANNOT bypass Scheduler

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveTaskAtomic } from '../lib/store.mjs';
import {
  evaluateIntentPolicy,
  INTENT_STATUSES,
  INTENT_REASONS,
} from './intent-policy.mjs';
import {
  validateAndComputeEffectiveAction,
  GATE_VERDICTS,
  CURRENT_CONTRACT_VERSION,
} from '../intent/action-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TASKS_DIR = process.env.AF_TASKS_DIR || join(ROOT, 'tasks');

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export const FORBIDDEN_FIELDS = Object.freeze([
  'executor',
  'platform',
  'policy_decision',
  'human_gate_status',
  'governance_bypass',
  'override_governance',
  'skip_governance',
  'candidate_id',
]);

/**
 * Validate input objects against governance and platform leakage.
 */
export function validateIntentArgs(args = {}) {
  if (!args || typeof args !== 'object') {
    throw new Error('[invalid_argument] Arguments must be a JSON object');
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (field in args) {
      throw new Error(`[boundary_violation] Field "${field}" is forbidden in Intent Alignment Gate (ROLE != PLATFORM / Single Governance).`);
    }
  }
  return true;
}

/**
 * Load a task file from disk.
 */
function loadTaskFile(taskId, tasksDir = TASKS_DIR) {
  const filePath = join(tasksDir, `${taskId}.json`);
  if (!existsSync(filePath)) {
    const err = new Error(`task not found: ${taskId}`);
    err.code = 'TASK_NOT_FOUND';
    throw err;
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function mapActionToReason(effectiveAction) {
  switch (effectiveAction.action_type) {
    case 'MODIFY_GOVERNANCE':
      return INTENT_REASONS.KNOWLEDGE_GOVERNANCE_CHANGE;
    case 'MODIFY_SYSTEM_CONFIG':
      return INTENT_REASONS.SYSTEM_CONFIG_CHANGE;
    case 'MODIFY_KNOWLEDGE_STRUCTURE':
      return INTENT_REASONS.DIRECTION_CONFIRMATION;
    case 'DELETE_ARTIFACT':
      return effectiveAction.target.type === 'TEMP_CACHE' && effectiveAction.impact.reversible
        ? INTENT_REASONS.ROUTINE_CLEANUP
        : INTENT_REASONS.DESTRUCTIVE_DELETION;
    case 'DEPLOY_EXTERNAL':
      return INTENT_REASONS.EXTERNAL_RELEASE;
    default:
      return INTENT_REASONS.ROUTINE_TASK;
  }
}

/**
 * Evaluate and align a task's intent before scheduling.
 *
 * @param {object} taskCapsule - The Task Capsule
 * @param {object|null} taskPlan - The plan from Planner Layer
 * @param {object} options - Options (tasksDir)
 * @returns {object} Alignment result
 */
export function alignTaskIntent(taskCapsule, taskPlan = null, { tasksDir = null } = {}) {
  if (!taskCapsule || typeof taskCapsule !== 'object') {
    throw new Error('[invalid_capsule] Task Capsule must be an object');
  }

  validateIntentArgs(taskCapsule);

  // PHASE 10 & 10.1: Deterministic Action Validator computes Effective Action
  const proposal = taskCapsule.action_proposal || taskPlan?.action_proposal || null;
  const effectiveAction = validateAndComputeEffectiveAction(proposal, taskCapsule, taskPlan);

  taskCapsule.action_contract_version = CURRENT_CONTRACT_VERSION;
  taskCapsule.action_proposal = proposal || {
    contract_version: CURRENT_CONTRACT_VERSION,
    action_type: effectiveAction.action_type,
    target: effectiveAction.target,
    impact: effectiveAction.impact,
  };
  taskCapsule.effective_action = effectiveAction;

  const dir = tasksDir || TASKS_DIR;
  const isWaitingHuman = effectiveAction.required_gate === GATE_VERDICTS.WAITING_HUMAN;
  const mappedReason = mapActionToReason(effectiveAction);

  if (isWaitingHuman) {
    taskCapsule.state = 'WAITING_HUMAN';
    taskCapsule.intent_alignment = {
      required: true,
      reason: mappedReason,
      description: effectiveAction.escalated
        ? `[escalated] ${effectiveAction.escalation_reason}`
        : `Action ${effectiveAction.action_type} on ${effectiveAction.target.type} requires human confirmation`,
      status: INTENT_STATUSES.PENDING_HUMAN,
      audit_evidence: effectiveAction.audit_evidence || [],
      action_contract_version: CURRENT_CONTRACT_VERSION,
      evaluated_at: effectiveAction.evaluated_at,
    };

    if (taskCapsule.task_id) {
      try {
        mkdirSync(dir, { recursive: true });
        saveTaskAtomic(join(dir, `${taskCapsule.task_id}.json`), taskCapsule);
      } catch {
        // Tolerant if in-memory test
      }
    }

    return {
      required: true,
      status: 'WAITING_HUMAN',
      task_id: taskCapsule.task_id,
      effective_action: effectiveAction,
      intent_alignment: taskCapsule.intent_alignment,
    };
  }

  taskCapsule.state = taskCapsule.state || 'READY';
  taskCapsule.intent_alignment = {
    required: false,
    reason: mappedReason,
    description: `Action ${effectiveAction.action_type} on ${effectiveAction.target.type} is auto-allowed`,
    status: INTENT_STATUSES.AUTO_ALLOWED,
    audit_evidence: effectiveAction.audit_evidence || [],
    action_contract_version: CURRENT_CONTRACT_VERSION,
    evaluated_at: effectiveAction.evaluated_at,
  };

  return {
    required: false,
    status: 'AUTO_ALLOWED',
    task_id: taskCapsule.task_id,
    effective_action: effectiveAction,
    intent_alignment: taskCapsule.intent_alignment,
  };
}

/**
 * Approve a pending task's intent (Human Alignment Confirmation).
 * Transitions state from WAITING_HUMAN -> APPROVED.
 *
 * @param {string} taskId - The task ID to approve
 * @param {object} options - Options (reason, approvedBy, tasksDir)
 * @returns {object} { task_id, status: 'APPROVED', task }
 */
export function approveIntent(taskId, {
  reason = '确认执行该方案',
  approvedBy = 'user',
  tasksDir = null,
} = {}) {
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('[invalid_argument] "task_id" is required and must be a string');
  }

  validateIntentArgs({ reason, approvedBy });

  const dir = tasksDir || TASKS_DIR;
  const task = loadTaskFile(taskId, dir);

  if (TERMINAL_STATES.has(task.state)) {
    const err = new Error(`TASK_ALREADY_TERMINAL: task ${taskId} is already in terminal state ${task.state}`);
    err.code = 'TASK_ALREADY_TERMINAL';
    throw err;
  }

  if (task.state !== 'WAITING_HUMAN' && task.intent_alignment?.status !== INTENT_STATUSES.PENDING_HUMAN) {
    const err = new Error(`NOT_WAITING_HUMAN: task ${taskId} is ${task.state}, not WAITING_HUMAN`);
    err.code = 'NOT_WAITING_HUMAN';
    throw err;
  }

  // Update intent alignment record
  task.state = 'APPROVED';
  task.intent_alignment = {
    ...(task.intent_alignment || {}),
    required: true,
    status: INTENT_STATUSES.APPROVED,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    approval_reason: reason,
  };

  saveTaskAtomic(join(dir, `${taskId}.json`), task);

  return {
    task_id: taskId,
    status: 'APPROVED',
    message: reason,
    task,
  };
}

/**
 * Reject a pending task's intent.
 * Transitions state to CANCELLED.
 *
 * @param {string} taskId - The task ID to reject
 * @param {object} options - Options (reason, rejectedBy, tasksDir)
 * @returns {object} { task_id, status: 'CANCELLED', task }
 */
export function rejectIntent(taskId, {
  reason = '方向不符合要求',
  rejectedBy = 'user',
  tasksDir = null,
} = {}) {
  if (!taskId || typeof taskId !== 'string') {
    throw new Error('[invalid_argument] "task_id" is required and must be a string');
  }

  validateIntentArgs({ reason, rejectedBy });

  const dir = tasksDir || TASKS_DIR;
  const task = loadTaskFile(taskId, dir);

  if (TERMINAL_STATES.has(task.state)) {
    const err = new Error(`TASK_ALREADY_TERMINAL: task ${taskId} is already in terminal state ${task.state}`);
    err.code = 'TASK_ALREADY_TERMINAL';
    throw err;
  }

  task.state = 'CANCELLED';
  task.cancel_reason = reason;
  task.cancelled_at = new Date().toISOString();
  task.cancelled_by = rejectedBy;
  task.intent_alignment = {
    ...(task.intent_alignment || {}),
    required: true,
    status: INTENT_STATUSES.CANCELLED,
    cancelled_by: rejectedBy,
    cancelled_at: task.cancelled_at,
    rejection_reason: reason,
  };

  saveTaskAtomic(join(dir, `${taskId}.json`), task);

  return {
    task_id: taskId,
    status: 'CANCELLED',
    message: reason,
    task,
  };
}
