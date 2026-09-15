// executor-router.mjs - PHASE 6-C Multi Executor Routing
//
// Responsibilities:
//   Pure deterministic funnel function for multi-executor selection and fallback ordering.
//
// Funnel stages:
//   Step 1: Capability Filter (requires_mcp, enterprise compliance, etc.)
//   Step 2: Availability Filter (UNAVAILABLE, ACCOUNT_DISABLED blockers)
//   Step 3: Runtime Filter (OPEN_MANUAL_RESET, PROBING, active cooldown)
//   Step 4: Priority Sort (default: vertex-gemini -> claude -> codex -> antigravity)
//
// Invariants (Strict):
//   - Pure function: NO state persistence, NO spawn, NO network calls, NO task mutations.
//   - ROLE != PLATFORM: never statically binds roles to platforms.

import { loadExecutorStatus, EXECUTORS_DIR } from './executor-status.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PRIORITY_ORDER = Object.freeze([
  'vertex-gemini',
  'claude',
  'codex',
  'antigravity',
]);

/**
 * Load capability facts from executors directory into Map<id, json>
 */
export function loadCapabilityMap(dir = EXECUTORS_DIR) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'contract.json') continue;
    try {
      const json = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const id = json.executor_id || f.replace(/\.json$/, '');
      map.set(id, json);
    } catch { /* skip invalid */ }
  }
  return map;
}

/**
 * Deterministic router function
 *
 * @param {Object} taskCapsule - Task definition capsule
 * @param {Object} [options]
 * @param {string} [options.role] - 'author' | 'reviewer' | null
 * @param {Map} [options.capabilityMap] - Map of executor capabilities
 * @param {Map} [options.availabilityMap] - Map of executor availability
 * @param {Object} [options.runtimeGuard] - RuntimeGuard instance or { getCircuitState(id) }
 * @param {string[]} [options.priorityOrder] - Priority ordering list
 * @param {Object} [options.adapters] - Optional adapters map to restrict candidates
 * @returns {{ primary: string | null, fallbacks: string[] }}
 */
export function resolveExecutorRoute(taskCapsule = {}, {
  role = null,
  capabilityMap = null,
  availabilityMap = null,
  runtimeGuard = null,
  priorityOrder = null,
  adapters = null,
} = {}) {
  const caps = capabilityMap || loadCapabilityMap();
  const avails = availabilityMap || loadExecutorStatus();
  const rawPriority = (Array.isArray(priorityOrder) && priorityOrder.length ? priorityOrder : null)
    || (Array.isArray(taskCapsule?.priority_order) && taskCapsule.priority_order.length ? taskCapsule.priority_order : null)
    || (process.env.AF_EXECUTOR_PRIORITY ? process.env.AF_EXECUTOR_PRIORITY.split(',').map((s) => s.trim()) : null)
    || DEFAULT_PRIORITY_ORDER;
  const priorities = rawPriority;

  // Determine preference
  const rawPref = role === 'reviewer'
    ? (taskCapsule.reviewer_executor || taskCapsule.executor)
    : (taskCapsule.author_executor || taskCapsule.executor);
  const preference = rawPref && rawPref !== 'auto' ? rawPref : null;

  // Candidate pool: active priorities + explicit preference (if specified)
  const pool = new Set([...priorities]);
  if (preference) pool.add(preference);

  const eligible = [];

  for (const id of pool) {
    // Adapter presence check: if adapters provided, id must exist in adapters
    if (adapters && !adapters[id]) {
      continue;
    }

    // Step 1: Capability Filter
    const cap = caps instanceof Map ? caps.get(id) : caps?.[id];
    const requiresMcp = !!taskCapsule.requires_mcp;
    if (requiresMcp) {
      const mcpPass = cap?.capabilities_audit?.mcp_unattended === 'PASS'
        || (adapters && adapters[id]?.supportsMcpUnattended === true);
      const mcpBlocked = cap?.capabilities_audit?.mcp_unattended === 'BLOCKED'
        || (adapters && adapters[id]?.supportsMcpUnattended === false);
      if (mcpBlocked || !mcpPass) {
        continue; // Exclude executors that cannot satisfy unattended MCP
      }
    }

    if (taskCapsule.compliance === 'enterprise') {
      if (cap?.platform !== 'cloud-enterprise' && id !== 'vertex-gemini') {
        continue;
      }
    }

    // Step 2: Availability Filter
    const avail = avails instanceof Map ? avails.get(id) : avails?.[id];
    if (avail) {
      if (avail.reason && /account.*disabled|403|tos/i.test(avail.reason)) {
        continue;
      }
      if (avail.availability_status === 'UNAVAILABLE') {
        const isMcpOnlyBlocker = /mcp/i.test(avail.blocker || '') && !/account|tos|disabled/i.test(avail.blocker || '');
        if (isMcpOnlyBlocker && !requiresMcp) {
          // MCP blocker does not block non-MCP task
        } else {
          continue;
        }
      }
    }
    if (adapters && adapters[id]?.schedulable === false) {
      continue;
    }

    // Step 3: Runtime Filter
    if (runtimeGuard) {
      if (typeof runtimeGuard.canExecute === 'function') {
        if (!runtimeGuard.canExecute(id)) {
          continue;
        }
      } else {
        const circuit = runtimeGuard.getCircuitState
          ? runtimeGuard.getCircuitState(id)
          : (runtimeGuard[id] || { state: 'CLOSED' });
        const state = circuit?.state || 'CLOSED';
        if (state === 'OPEN_MANUAL_RESET' || state === 'PROBING') {
          continue;
        }
        if (state === 'OPEN_COOLDOWN') {
          const now = typeof runtimeGuard.now === 'function' ? runtimeGuard.now() : Date.now();
          if (circuit.cooldown_until && now < circuit.cooldown_until) {
            continue;
          }
        }
      }
    }

    eligible.push(id);
  }

  // Step 4: Priority Sort
  eligible.sort((a, b) => {
    const idxA = priorities.indexOf(a);
    const idxB = priorities.indexOf(b);
    const rankA = idxA === -1 ? 999 : idxA;
    const rankB = idxB === -1 ? 999 : idxB;
    return rankA - rankB;
  });

  if (preference) {
    if (eligible.includes(preference)) {
      return {
        primary: preference,
        fallbacks: eligible.filter((id) => id !== preference),
      };
    } else {
      // Explicit preference requested but ineligible
      return {
        primary: null,
        fallbacks: eligible,
      };
    }
  }

  return {
    primary: eligible[0] || null,
    fallbacks: eligible.slice(1),
  };
}
