#!/bin/bash
# make-fixture.sh - build the Phase 1 E2E fixture repo (deterministic)
# Usage: make-fixture.sh <dir>
set -eu
DIR="${1:?usage: make-fixture.sh <dir>}"
rm -rf "$DIR"
mkdir -p "$DIR"
cat > "$DIR/calc.js" <<'EOF'
// Adds two numbers.
export function add(a, b) {
  return a - b; // BUG: intentionally wrong
}
EOF
cat > "$DIR/calc.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert';
import { add } from './calc.js';

test('add(1,2) === 3', () => { assert.strictEqual(add(1, 2), 3); });
test('add(0,0) === 0', () => { assert.strictEqual(add(0, 0), 0); });
EOF
cd "$DIR"
git init -q 2>/dev/null || true
git add -A 2>/dev/null || true
git commit -qm "fixture: calc with intentional bug" 2>/dev/null || true
echo "fixture ready at $DIR"
node --test "$DIR/calc.test.js" 2>&1 | tail -5 || true
