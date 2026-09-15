#!/bin/bash
# PHASE 4 Real-Host Recovery R1: real Claude, real crash (SIGKILL), real recovery
export PATH=/home/relaret/.nvm/versions/node/v24.20.0/bin:$PATH
cd /mnt/c/Users/relaret/agent-foundry-orchestrator

echo "=== build fixture ==="
bash fixtures/make-fixture.sh /tmp/af-rh1 >/dev/null 2>&1

cat > tasks/rh1.json <<'EOF'
{
  "task_id": "TASK-REAL-RH1",
  "goal": "Fix the bug in calc.js: add(a, b) must return a + b instead of a - b. Keep the change minimal. First line of calc.js must stay a comment describing add().",
  "acceptance": "node --test calc.test.js passes all tests.",
  "acceptance_cmd": { "command": "node", "args": ["--test", "calc.test.js"] },
  "red_lines": ["Only modify files inside the fixture directory", "Do not delete or weaken the existing tests"],
  "review_rules": [
    "calc.js: add(a,b) returns a + b (cite file:line)",
    "calc.test.js is unchanged and still asserts add(1,2)===3 and add(0,0)===0",
    "STYLE_RULE: every exported function in calc.js must carry a JSDoc block comment (/** ... */); a plain // comment does NOT satisfy this"
  ],
  "fixture_dir": "/tmp/af-rh1",
  "requires_mcp": false,
  "author_executor": "claude",
  "reviewer_executor": "claude",
  "max_revisions": 3
}
EOF

echo "=== start orchestrator run in background (real crash target) ==="
node orchestrator.mjs run --task-file tasks/rh1.json > /tmp/af-rh1-run.log 2>&1 &
RUNPID=$!
echo "orchestrator pid: $RUNPID"

echo "=== poll until author persisted + review running, then SIGKILL ==="
for i in $(seq 1 60); do
  STATE=$(python3 -c "
import json
try:
    d = json.load(open('tasks/TASK-REAL-RH1.json'))
    author_done = any(r.get('purpose')=='author' and r.get('status')=='completed' for r in d.get('runs',[]))
    print(d['state'], author_done)
except Exception as e:
    print('WAIT', False)
" 2>/dev/null)
  CUR=$(echo $STATE | cut -d' ' -f1)
  ADONE=$(echo $STATE | cut -d' ' -f2)
  if [ "$CUR" = "REVIEW_RUNNING" ] && [ "$ADONE" = "True" ]; then
    echo "crash point reached (state=$CUR author persisted) after ${i} polls"
    break
  fi
  sleep 2
done
kill -9 $RUNPID 2>/dev/null
sleep 1
kill -9 $RUNPID 2>/dev/null
echo "orchestrator SIGKILLed (crash simulated)"
echo "task state after crash:"
python3 -c "
import json
d = json.load(open('tasks/TASK-REAL-RH1.json'))
print(' state:', d['state'], '| author_session_ref:', d.get('author_session_ref'))
print(' runs:', [(r['purpose'], r['status'], (r.get('session_ref') or '')[:8]) for r in d.get('runs', [])])
"
