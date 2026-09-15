#!/bin/bash
# make-governed-fixture.sh - hermetic fixture vault for PHASE 2 E2E
# Copies the minimal vault skeleton (same recipe as vault-mcp's own
# test-human-gate.mjs) into an isolated dir with an isolated state.db.
# The REAL vault is never touched. Usage: make-governed-fixture.sh <dir>
set -eu
DIR="${1:?usage: make-governed-fixture.sh <dir>}"
SRC="/mnt/c/Users/relaret/agent-foundry-vault"
rm -rf "$DIR"
mkdir -p "$DIR"
for f in AGENTS.md SCHEMA.md index.md log.md; do cp "$SRC/$f" "$DIR/$f"; done
mkdir -p "$DIR/harness" "$DIR/policies"
for f in policy.mjs executor-registry.mjs runtime-recorder.mjs schema-validator.mjs; do cp "$SRC/harness/$f" "$DIR/harness/$f"; done
cp "$SRC/policies/permissions.json" "$DIR/policies/permissions.json"
mkdir -p "$DIR/10-收件箱/写回候选" "$DIR/concepts" "$DIR/raw" "$DIR/99-af-e2e"
# empty markdown skeleton for copied formal docs (fixture needs valid vault shape)
: > "$DIR/10-收件箱/写回候选/.keep"
echo "fixture vault ready: $DIR"
