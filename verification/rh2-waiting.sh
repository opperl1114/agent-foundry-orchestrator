#!/bin/bash
export PATH=/home/relaret/.nvm/versions/node/v24.20.0/bin:$PATH
cd /mnt/c/Users/relaret/agent-foundry-orchestrator

echo "=== reset hermetic fixture vault ==="
bash fixtures/make-governed-fixture.sh /tmp/af-gov-vault >/dev/null 2>&1

cat > tasks/rh2.json <<'EOF'
{
  "task_id": "TASK-REAL-RH2",
  "task_mode": "governed_write",
  "goal": "Write the documentation page 'About the 99-af-e2e fixture area' for this fixture vault. First line must be: '> Agent Foundry Orchestrator E2E tooling - description of the 99-af-e2e fixture area.' Content must state accurately: (1) 99-af-e2e/ holds throwaway artifacts of governed-write E2E probes; (2) targets under it are unmatched by the L2 path rules so policy classifies them L3-governed and requires a real Human Gate; (3) cleanup is a full fixture reset via fixtures/make-governed-fixture.sh. Only reference this target path (99-af-e2e/af-rh2-gate-probe.md).",
  "acceptance": "Author produces the page content; QA review passes; policy decides.",
  "acceptance_cmd": { "command": "node", "args": ["-e", "process.exit(0)"] },
  "red_lines": ["Only fixture content"],
  "review_rules": [
    "The page's first line is the required tooling marker",
    "The page accurately describes the 99-af-e2e area purpose, the L3/human-gate consequence, and the fixture-reset cleanup",
    "PASS if both hold - this is real tool documentation sourced from the task definition"
  ],
  "fixture_dir": "/tmp/af-gov-vault",
  "requires_mcp": true,
  "author_executor": "claude",
  "reviewer_executor": "claude",
  "max_revisions": 2,
  "candidate": {
    "title": "About the 99-af-e2e fixture area (RH2)",
    "target": "99-af-e2e/af-rh2-gate-probe.md",
    "knowledge_class": "procedural",
    "sources": ["agent-foundry-orchestrator/fixtures/make-governed-fixture.sh", "agent-foundry-orchestrator/tasks/rh2.json"],
    "publish_tags": ["tooling", "agent-harness"],
    "publish_summary": "Purpose and cleanup of the 99-af-e2e fixture area (RH2 real-host recovery probe)",
    "rationale": "PHASE 4 RH2 real-host recovery probe"
  },
  "governance_env": {
    "server_path": "/mnt/c/Users/relaret/vault-mcp/server.mjs",
    "vault_root": "/tmp/af-gov-vault",
    "state_db": "/tmp/af-gov-vault/state.db",
    "reviewer_mcp_config": "/mnt/c/Users/relaret/agent-foundry-orchestrator/fixtures/fixture-vault-mcp.json",
    "reviewer_allowed_tools": "mcp__agent-foundry-vault-fixture__agent_register,mcp__agent-foundry-vault-fixture__review_candidate",
    "reviewer_server_name": "agent-foundry-vault-fixture"
  }
}
EOF

echo "=== run governed task to WAITING_HUMAN (natural park) ==="
node orchestrator.mjs run --task-file tasks/rh2.json 2>&1 | tail -6

echo
echo "=== simulate restart: recover --scan (read-only) ==="
node orchestrator.mjs recover --scan 2>&1 | grep -A11 'TASK-REAL-RH2'

echo
echo "=== confirm NOTHING was re-run: candidate count + no publish ==="
node --experimental-sqlite -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/tmp/af-gov-vault/state.db");
const c = db.prepare("SELECT candidate_id, task_id, mode FROM candidates WHERE task_id = ?").all("TASK-REAL-RH2");
console.log("candidates for TASK-REAL-RH2:", JSON.stringify(c));
const pub = db.prepare("SELECT published_path FROM decisions WHERE task_id = ?").all("TASK-REAL-RH2");
console.log("publish decisions:", JSON.stringify(pub));
' 2>&1

echo "=== real vault zero touch ==="
ls '/mnt/c/Users/relaret/agent-foundry-vault/10-收件箱/写回候选/' 2>/dev/null | grep -iE 'RH2|99-af-e2e' || echo "zero touch confirmed (real vault inbox clean)"
node --experimental-sqlite -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/home/relaret/.local/share/agent-foundry-mcp/state.db");
const i = db.prepare("SELECT agent_instance_id FROM agent_instances WHERE task_id LIKE ?").all("%RH2%");
console.log(JSON.stringify({ real_db_RH2_instances: i.length }));
' 2>&1
