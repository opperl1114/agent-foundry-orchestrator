// executor-status.mjs - PHASE 3 capability vs availability projection
//
// This is NOT a second capability registry. The single capability truth is
// agent-foundry-global/executors/*.json; this module READS those canonical
// files fresh on every call, never writes them, and only projects them onto
// the two axes the Phase 3 scheduler must separate:
//
//   capability_status  - what the executor's MECHANISM can do (version-pinned
//                        audit result). agy's 403 account disable is NOT a
//                        capability change: it must never be downgraded here.
//   availability_status - whether the executor can be STARTED right now
//                        (account / environment blockers from the canonical
//                        blockers list).
//
// Derivation (documented, deterministic, canonical-file-driven):
//   capability_status:  capabilities_audit all PASS -> READY
//                       any BLOCKED entry           -> PARTIAL
//   availability_status: account/403/ToS blocker  -> UNAVAILABLE (ACCOUNT_DISABLED_403)
//                        other blocker            -> UNAVAILABLE (EXECUTOR_BLOCKED)
//                        no blockers              -> AVAILABLE

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXECUTORS_DIR, CODEX_CONFIG_PATH, CLAUDE_SETTINGS_PATH, CLINE_SETTINGS_PATH } from './config.mjs';

export { EXECUTORS_DIR };

function deriveCapability(json) {
  const audit = json.capabilities_audit ?? {};
  const vals = Object.values(audit).map((v) => String(v).toUpperCase());
  if (vals.length && vals.every((v) => v === 'PASS')) return 'READY';
  if (vals.some((v) => v === 'BLOCKED')) return 'PARTIAL';
  if (vals.length && vals.some((v) => v === 'FAIL')) return 'BLOCKED';
  return 'UNKNOWN';
}

function deriveAvailability(json) {
  const blockers = Array.isArray(json.blockers) ? json.blockers : [];
  const acct = blockers.find((b) => /account|403|disabled|terms of service|tos/i.test(String(b)));
  if (acct) {
    return {
      availability_status: 'UNAVAILABLE',
      reason: /403|terms of service|tos/i.test(String(acct)) ? 'ACCOUNT_DISABLED_403' : 'EXECUTOR_BLOCKED',
      blocker: String(acct).slice(0, 300),
    };
  }
  if (blockers.length) {
    return { availability_status: 'UNAVAILABLE', reason: 'EXECUTOR_BLOCKED', blocker: String(blockers[0]).slice(0, 300) };
  }
  return { availability_status: 'AVAILABLE', reason: null, blocker: null };
}

// Map executor_id -> { capability_status, availability_status, reason, ... }
export function loadExecutorStatus(dir = EXECUTORS_DIR) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'contract.json') continue;
    let json;
    try { json = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const id = json.executor_id ?? f.replace(/\.json$/, '');
    const cap = deriveCapability(json);
    const avail = deriveAvailability(json);
    out.set(id, {
      executor_id: id,
      capability_status: cap,
      availability_status: avail.availability_status,
      reason: avail.reason,
      blocker: avail.blocker,
      source: join(dir, f), // canonical truth; read-only projection
    });
  }
  return out;
}

export function getExecutorEffectiveProfile(executorType, { model = null, effort = null, role = null } = {}) {
  const type = String(executorType || '').toLowerCase();
  if (type === 'codex') {
    let cfgModel = 'default';
    let cfgEffort = 'default';
    const cfgPath = CODEX_CONFIG_PATH;
    if (existsSync(cfgPath)) {
      try {
        const text = readFileSync(cfgPath, 'utf8');
        const m = text.match(/^model\s*=\s*["']([^"']+)["']/m);
        if (m) cfgModel = m[1];
        const e = text.match(/^model_reasoning_effort\s*=\s*["']([^"']+)["']/m);
        if (e) cfgEffort = e[1];
      } catch { /* ignore */ }
    }
    return {
      executor: 'codex',
      role: role || 'unspecified',
      model: model || cfgModel,
      model_source: model ? 'task_override' : 'config.toml',
      effort: effort || cfgEffort,
      effort_source: effort ? 'task_override' : 'config.toml',
      mcp_unattended: true,
      sandbox: 'read-only / workspace-write (orchestrator enforced)',
    };
  }
  if (type === 'claude') {
    let cfgModel = 'claude-3-7-sonnet';
    const cfgPath = CLAUDE_SETTINGS_PATH;
    if (existsSync(cfgPath)) {
      try {
        const j = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (j.model) cfgModel = j.model;
      } catch { /* ignore */ }
    }
    return {
      executor: 'claude',
      role: role || 'unspecified',
      model: model || cfgModel,
      model_source: model ? 'task_override' : 'settings.json',
      effort: effort || 'default',
      effort_source: effort ? 'task_override' : 'cli_default',
      mcp_unattended: true,
      sandbox: 'permission-mode',
    };
  }
  if (type === 'cline') {
    let cfgModel = 'default';
    let cfgEffort = 'medium';
    let providerName = 'cline';
    const cfgPath = CLINE_SETTINGS_PATH;
    if (existsSync(cfgPath)) {
      try {
        const data = JSON.parse(readFileSync(cfgPath, 'utf8'));
        const activeKey = data.lastUsedProvider || 'cline';
        providerName = activeKey;
        const activeProv = data.providers?.[activeKey];
        if (activeProv?.settings?.model) cfgModel = activeProv.settings.model;
        if (activeProv?.settings?.reasoning?.enabled && activeProv.settings.reasoning.effort) {
          cfgEffort = activeProv.settings.reasoning.effort;
        }
      } catch { /* ignore */ }
    }
    return {
      executor: 'cline',
      role: role || 'unspecified',
      model: model || cfgModel,
      model_source: model ? 'task_override' : `providers.json (${providerName})`,
      effort: effort || cfgEffort,
      effort_source: effort ? 'task_override' : 'providers.json',
      mcp_unattended: true,
      sandbox: 'auto-approve',
    };
  }
  if (type === 'vertex-gemini') {
    const hasCreds = !!process.env.VERTEX_API_KEY || !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!hasCreds) {
      return {
        executor: 'vertex-gemini',
        role: role || 'unspecified',
        configured: false,
        model: 'unconfigured (未配置凭据)',
        model_source: 'none',
        effort: 'none',
        effort_source: 'none',
        mcp_unattended: false,
        sandbox: 'enterprise-governance',
        note: '未完成配置：缺少 VERTEX_API_KEY 或 GOOGLE_APPLICATION_CREDENTIALS',
      };
    }
    return {
      executor: 'vertex-gemini',
      role: role || 'unspecified',
      configured: true,
      model: model || 'gemini-2.5-pro',
      model_source: model ? 'task_override' : 'vertex_default',
      effort: effort || 'standard',
      effort_source: effort ? 'task_override' : 'vertex_default',
      mcp_unattended: true,
      sandbox: 'enterprise-governance',
    };
  }
  return {
    executor: type,
    role: role || 'unspecified',
    model: model || 'default',
    model_source: model ? 'task_override' : 'unknown',
    effort: effort || 'default',
    effort_source: effort ? 'task_override' : 'unknown',
    mcp_unattended: false,
    sandbox: 'unknown',
  };
}

