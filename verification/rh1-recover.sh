#!/bin/bash
export PATH=/home/relaret/.nvm/versions/node/v24.20.0/bin:$PATH
cd /mnt/c/Users/relaret/agent-foundry-orchestrator
echo "=== restart: recover --scan (no execution) ==="
node orchestrator.mjs recover --scan 2>&1 | head -14
echo
echo "=== operator decides: recover --task-id TASK-REAL-RH1 ==="
node orchestrator.mjs recover --task-id TASK-REAL-RH1 2>&1 | tail -18
echo
echo "=== post-recovery evidence ==="
python3 - <<'EOF'
import json
d = json.load(open('tasks/TASK-REAL-RH1.json'))
print('state:', d['state'], '| revisions:', d.get('revisions_used'))
for r in d.get('runs', []):
    print(f"  {r['purpose']:8} {r['executor_run_id']} {r['status']:9} sess={(r.get('session_ref') or '')[:12]}")
print('author_session_ref preserved:', d.get('author_session_ref'))
ra = d.get('recovery_attempts') or []
print('recovery_attempts:', [(a.get('classification'), a.get('outcome')) for a in ra])
EOF
