# Agent Foundry Orchestrator (PHASE 1 - 4 Maintenance Closure)

**Code path:** `C:\Users\relaret\agent-foundry-orchestrator\` (Windows), run from WSL via
`/mnt/c/Users/relaret/agent-foundry-orchestrator/` (nvm node v24). There is no copy under
WSL $HOME - this Windows path is the only orchestrator code location.

Control Plane for multi-executor task workflows. Fact baseline: PHASE 0 / 2A / 2B / 2C audits
(see `agent-foundry-global/executors/` - the single capability truth; this repo does not
duplicate it).

## Scope (frozen)

One user input -> author run -> structured review -> NEEDS_FIX -> auto resume original
author session -> fix -> re-review -> deterministic acceptance command -> then, for
`task_mode = governed_write`, the GovernanceBridge hands over to the existing vault-mcp
Governance Plane (candidate -> formal review -> policy -> publish) and maps the verdict
back. No human message relay anywhere in the loop.

States: `CREATED AUTHOR_RUNNING REVIEW_RUNNING NEEDS_FIX GOVERNANCE_PENDING
WAITING_HUMAN PUBLISHING COMPLETED FAILED CANCELLED`.
Governance truth (candidate, formal review, policy, Human Gate, writer lock, publish)
is and stays in vault-mcp; the orchestrator stores only an observed mirror with
`governance_source: "vault-mcp"` and never fabricates agent_instance_id / candidate_id.

## Usage

```bash
# fixture + task definition
fixtures/make-fixture.sh /tmp/af-e2e-a
node orchestrator.mjs run  --task-file tasks/e2e-a.json
node orchestrator.mjs status --task-id TASK-E2E-A
node orchestrator.mjs cancel --task-id TASK-E2E-A
```

Requires WSL node (nvm v24) on PATH. Launcher chain `claude-af -> claude-ccs -> claude`
is preserved; agy runs via `~/bin/agy-af`; codex via `codex exec` (Windows shim).

## Files

- `orchestrator.mjs` - state machine, task store (`tasks/<id>.json`), scheduling,
  deterministic acceptance command, max-revision guard (default 3)
- `lib/adapters.mjs` - Codex / Antigravity / Claude adapters: `run / resume / cancel /
  health` -> unified `ExecutorResult`; platform-private formats never leak into the core
- `lib/capsules.mjs` is intentionally absent - capsule construction lives in
  `orchestrator.mjs` until a second consumer exists
- `tasks/e2e-a.json`, `tasks/e2e-b.json` - E2E definitions (role-reversal pair)
- `fixtures/make-fixture.sh` - deterministic fixture repo (intentional bug)

## Scheduling rules (capability, not role)

- `ROLE != PLATFORM`: roles come from the task definition (`author_role` / `reviewer_role`), NEVER from platform binding. Claude, Codex, and agy are execution platforms only.
- `task_requires_mcp = true` excludes codex 0.147.0 (headless unattended MCP is
  `BLOCKED_BY_EXECUTOR_APPROVAL`; see `executors/codex.json`). This is a version
  capability constraint, never a platform role.
- Reviewer runs always use a session independent of the author session.
- Roles come from the task definition; executors are selected at scheduling time.

### Executor status & agy availability semantics

- **Antigravity (agy)**:
  - **capability**: `READY` (mechanisms verified PASS: non-interactive `--print`, structured output `--json-schema`, exact resume `--conversation <id>`, unattended MCP).
  - **availability**: `ACCOUNT_DISABLED_403` (upstream server returned ToS 403 on 2026-09-05; account-level blocker).
  - **scheduler**: `excluded` (`schedulable = false` in `lib/adapters.mjs`, verified by `TEST J-closure`).
  - **Semantic distinction**: This exclusion is strictly an **availability failure** (environmental/account blocker) projected from canonical truth, **NOT** a capability failure, and **NOT** a ROLE binding.
  - Invocations via `~/bin/agy-af` preserve canonical governance and workspace rules; bare `agy` is not called directly.

## Regression baseline

- Full suite command: `node --test`
- Test count & result: **39/39 PASS** (100% passing across 5 test suites):
  - `tests/cancellation.test.mjs`: 3 tests (TEST C1-C3 precise runId termination, cross-process cancel, task isolation)
  - `tests/concurrency.test.mjs`: 9 tests (E2E-A..G, restart scan, capability/availability separation)
  - `tests/governance.test.mjs`: 9 tests (TEST A-regression, B-gov, C-gov, E-gov, F-gov, G-gov, H-gov, J-closure, I-closure)
  - `tests/hardening.test.mjs`: 7 tests (TEST A-F, acceptance_cmd normalization)
  - `tests/recovery.test.mjs`: 11 tests (TEST A-J, availability gate)
- **Baseline correction note**: Historical references citing "40/40 PASS" are corrected to the exact true baseline of **39/39 PASS** (reflecting the exact suite count without artificial/fictitious test padding).
- Real-host closure:
  - `tests/real-host-cancel.mjs`: RHC1 / RHC2 / RHC3 PASS (real Claude subprocess signals, runId -> PID correlation, SIGTERM grace SIGKILL, zero governance touch)
  - `tests/real-host-verify.mjs`: R1 / R2 / R3 PASS (real Scheduler, real Claude, hermetic vault-mcp)

## E2E evidence

- E2E-A (L2 governed write, hermetic fixture vault): agy author + claude reviewer ->
  NEEDS_FIX -> agy resume fix -> PASS -> COMPLETED (Phase 1); Phase 2 re-run with
  claude author: QA PASS -> write_candidate -> formal review approve ->
  policy auto_publish -> published=true -> COMPLETED
- E2E-B (L3, roles originally reversed): claude author + agy reviewer -> NEEDS_FIX ->
  claude `--resume <session_id>` fix -> PASS -> COMPLETED (Phase 1); Phase 2 re-run
  (TASK-GOV-L3B): QA PASS -> formal review approve -> policy human_required ->
  WAITING_HUMAN (correct stop; awaiting real Human Gate)
- **Tamper / Review-Stale Protection E2E** (deliberately NOT called a "policy deny"
  E2E): candidate tampered after formal review -> `resume` -> vault content-hash
  protection rejects with `REVIEW_STALE` -> nothing published. Real policy-level
  `deny` (raw-overwrite) is not reachable through `write_candidate`'s schema and was
  **not exercised**; the deny mapping is covered by unit test with a scripted vault
  verdict.

Rollback: delete this directory. Nothing outside it was modified (a Phase 2
development leak into the real vault was cleaned the same day; see Phase 2 report).
