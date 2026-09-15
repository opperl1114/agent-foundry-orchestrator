// governance.mjs - GovernanceBridge (PHASE 2)
//
// Coordination ONLY. The bridge maps Control Plane state to the existing
// vault-mcp Governance Plane and back. It NEVER:
//   - decides write_class        (vault-mcp policy evaluator does)
//   - implements policy          (vault-mcp)
//   - decides Human Gate         (vault-mcp + local-human-cli approval)
//   - implements writer lock     (vault-mcp)
//   - writes formal Vault files  (vault-mcp publish)
//   - fabricates agent_instance_id / candidate_id (vault-mcp returns them)
//
// Every governance value stored on the task is an observed mirror with
// governance_source = "vault-mcp". The vault remains the only truth.

import { randomUUID } from 'node:crypto';
import { VaultMcpClient } from './vault-client.mjs';
import { VAULT_MCP_SERVER_PATH } from './config.mjs';

export const BRIDGE_ENV_DEFAULTS = {
  serverPath: VAULT_MCP_SERVER_PATH,
  // NO default vaultRoot. Phase 2 closure: a governed task must declare its
  // target vault explicitly (governance_env.vault_root). Falling back to the
  // real vault silently is forbidden - fixture tasks would pollute it.
  // Missing vault_root => GOVERNANCE_ENV_REQUIRED (fail-closed).
};

export class GovernanceBridge {
  constructor({ task_id, serverPath, vaultRoot, stateDb, env } = {}) {
    if (!vaultRoot) {
      // fail-closed: never fall back to the real vault implicitly
      const err = new Error('GOVERNANCE_ENV_REQUIRED: governed tasks must declare governance_env.vault_root explicitly (no implicit real-vault fallback)');
      err.code = 'GOVERNANCE_ENV_REQUIRED';
      throw err;
    }
    this.task_id = task_id;
    this.client = new VaultMcpClient({
      serverPath: serverPath ?? process.env.AF_VAULT_MCP_SERVER ?? BRIDGE_ENV_DEFAULTS.serverPath,
      vaultRoot,
      stateDb: stateDb ?? null,
      env,
    });
    this.requested_instance_id = null; // what the bridge mints locally
    this.agent_instance_id = null;     // what vault-mcp confirmed on register
  }

  // The bridge mints a requested_instance_id locally (vault-mcp requires the
  // client to supply one matching its pattern); ONLY after agent_register
  // succeeds does the vault-confirmed agent_instance_id exist. The final
  // identity truth is vault-mcp's registry.
  async ensureRegistered() {
    if (this.agent_instance_id) return this.agent_instance_id;
    const slug = String(this.task_id).toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);
    this.requested_instance_id = `af-bridge.${slug}.${randomUUID().slice(0, 8)}`;
    const { raw, json } = await this.client.call('agent_register', {
      task_id: this.task_id,
      executor: 'agent-foundry-orchestrator-bridge',
      role: 'worker',
      instance_id: this.requested_instance_id,
    });
    const id = json?.agent_instance_id ?? extractField(raw, 'agent_instance_id') ?? null;
    if (!id) throw new Error(`vault-mcp agent_register returned no agent_instance_id: ${raw.slice(0, 300)}`);
    this.agent_instance_id = id; // confirmed by vault-mcp registration
    return id;
  }

  // Create the candidate THROUGH vault-mcp (governed mode). candidate_id is
  // whatever vault-mcp returns; the bridge never invents one.
  async createCandidate({ title, content, target, knowledge_class, sources, publish_tags, publish_summary, rationale }) {
    const agent_instance_id = await this.ensureRegistered();
    const { raw, json } = await this.client.call('write_candidate', {
      title, content, target,
      knowledge_class: knowledge_class ?? 'procedural',
      sources, publish_tags, publish_summary, rationale,
      task_id: this.task_id,
      agent_instance_id,
    });
    const candidate_id = json?.candidate_id ?? extractField(raw, 'candidate_id');
    if (!candidate_id) throw new Error(`vault-mcp write_candidate returned no candidate_id: ${raw.slice(0, 300)}`);
    return { candidate_id, agent_instance_id, raw_response: raw };
  }

  // Publish (or attempt to). vault-mcp evaluates policy and returns one of:
  // published / human_required / deny (with decision reasons). The bridge
  // copies that verdict verbatim into the mirror; it never overrides it.
  async publish(candidate_id) {
    const agent_instance_id = await this.ensureRegistered();
    const { raw, json } = await this.client.call('publish_candidate', {
      candidate_id,
      agent_instance_id,
    });
    return { raw_response: raw, verdict: json ?? parseVerdict(raw) };
  }

  stop() { this.client.stop(); }
}

function extractField(text, field) {
  const m = text?.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

function parseVerdict(raw) {
  // vault-mcp human-readable fallback: look for the decision keywords it uses
  const t = raw ?? '';
  if (/deny/i.test(t) && !/auto_publish/i.test(t)) return { policy_decision: 'deny' };
  if (/human_required/i.test(t)) return { policy_decision: 'human_required' };
  if (/auto_publish|published/i.test(t)) return { policy_decision: 'auto_publish' };
  return { policy_decision: 'unknown', raw: t.slice(0, 500) };
}

// Phase 2 closure: the publish verdict is classified by OUTCOME, not by the
// policy_decision string. Key lesson from the L3 E2E: after a real Human Gate
// approval vault-mcp publishes the candidate while KEEPING policy_decision=
// "human_required" (that field is the strategy class, not the outcome) - the
// authoritative publish signal is published===true / published_path.
export function classifyPublishVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return 'unknown';
  if (verdict.published === true || verdict.published_path) return 'published';
  if (verdict.policy_decision === 'deny') return 'deny';
  if (verdict.policy_decision === 'human_required') return 'human_required';
  if (verdict.policy_decision === 'auto_publish' || verdict.policy_decision === 'auto_allow') return 'published';
  return 'unknown';
}
