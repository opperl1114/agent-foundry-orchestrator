# Agent Foundry Orchestrator - Release Manifest

## Release Overview

| Attribute | Specification |
| :--- | :--- |
| **Release Name** | Agent Foundry Orchestrator Production Freeze v1 |
| **Frozen At** | 2026-09-07T00:45:00+08:00 |
| **Architecture Reference** | [`FINAL_ARCHITECTURE.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/FINAL_ARCHITECTURE.md) |
| **Safety Model Reference** | [`EXECUTOR_SAFETY_MODEL.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/EXECUTOR_SAFETY_MODEL.md) |
| **Regression Test Status** | **91 / 91 PASS (100%)** |
| **Execution Engine** | Single-task state machine (`orchestrator.mjs` + `lib/scheduler.mjs`) |
| **Storage Architecture** | Filesystem atomic rename (`saveTaskAtomic`), zero SQLite/Postgres/Redis dependencies |

---

## Completed Phases Traceability

| Phase | Milestone Name | Key Architectural Deliverable |
| :--- | :--- | :--- |
| **PHASE 1** | Control Plane Core | Task file truth (`tasks/<id>.json`), POSIX atomic writes, author -> review -> acceptance state loop. |
| **PHASE 2** | Governance Bridge | Formal governance integration with `vault-mcp`, L2 `auto_publish` vs L3 `human_required`, fail-closed. |
| **PHASE 3** | Task QA Independence | Independent reviewer verification (`author_id != reviewer_id`), acceptance command whitelist enforcement. |
| **PHASE 4** | Task Recovery & Lock Management | `O_CREAT \| O_EXCL` file locks, dead PID reclamation, idempotent multi-stage crash recovery. |
| **PHASE 5-A/B/C** | Runtime Safety Guard | Circuit breaker (`CLOSED`, `OPEN_COOLDOWN`, `OPEN_MANUAL_RESET`), slot limits, burst launch protection. |
| **PHASE 6-A** | Enterprise Executor Adapter | Vertex Gemini enterprise adapter (`lib/adapters.mjs`), standardized run/resume/cancel/health lifecycle. |
| **PHASE 6-B** | Gated Executor Recovery | Manual-only circuit recovery: isolated sandbox probe -> evidence generation -> operator admit gate. |
| **PHASE 6-C** | Multi-Executor Routing | Deterministic pure-function funnel (`lib/executor-router.mjs`), capability/availability filters, transient fallback. |
| **PHASE 7-A** | Graceful Shutdown | Process termination handler for `SIGTERM`/`SIGINT`, active child process tree cleanup, orphan elimination. |
| **PHASE 7-B** | Operator Maintenance Layer | Operator CLI tool (`af-admin.mjs`), executor status inspect, terminal task prune, audit log rotation. |
| **PHASE 8-A** | Production Readiness Audit | Persistence check, security scan, executor status matrix, 5 failure injection tests, operator runbook. |
| **PHASE 8-B** | Production Freeze Documentation | Release manifest, change control protocol, disaster recovery runbook, architecture invariant tests. |

---

## Core Runtime Guarantees

1. **ROLE != PLATFORM**:
   - Platforms (`codex`, `claude`, `antigravity`, `vertex-gemini`) are strictly execution adapters.
   - Roles (`author`, `reviewer`, `verifier`, `operator`) are dynamic attributes assigned per Task Capsule.
   - No executor is hardcoded to any task role.
2. **Governance Single Source of Truth**:
   - All formal knowledge governance decisions derive solely from `agent-foundry-vault` via `vault-mcp`.
   - The Orchestrator never computes, fakes, or relaxes governance policy locally.
3. **Capability / Availability / Runtime Safety Separation**:
   - **Capability**: Statically defined in `agent-foundry-global/executors/*.json` (e.g. MCP support, terminal support).
   - **Availability**: Dynamically tracked based on provider account standing (e.g. `ACCOUNT_DISABLED`, `UNAVAILABLE`).
   - **Runtime Safety**: Managed in-memory and persisted by `ExecutorRuntimeGuard` (concurrency slot, circuit breaker).
4. **Fail-Closed Principle**:
   - Any fatal policy violation (`ACCOUNT_POLICY`, 403 Forbidden, TOS violation) immediately trips the circuit to `OPEN_MANUAL_RESET`.
   - Under fatal errors, automatic retries are strictly 0, router fallback is strictly forbidden, and the task halts fail-closed.
5. **Exact Resume Integrity**:
   - Fix loops and crash recovery preserve the exact provider `session_ref`, maintaining conversation context.
   - A recovery attempt with mismatched state version or corrupted state fails closed without overwriting.
6. **Zero Credential Persistence**:
   - The Orchestrator never writes API keys, tokens, auth headers, passwords, or raw prompts/responses to disk.
   - All operational logs (`runtime/executor-runtime-events.jsonl`) pass through a strict key-level sanitizer.

---

## File Manifest & Component Baseline

```
agent-foundry-orchestrator/
├── orchestrator.mjs                   # Main Orchestrator CLI & Lifecycle Entry
├── af-admin.mjs                       # Operator Administration CLI
├── lib/
│   ├── acceptance.mjs                 # Acceptance command whitelist & sandbox execution
│   ├── adapters.mjs                   # Unified Executor Adapters (Claude, Antigravity, Codex, Vertex)
│   ├── executor-error-classifier.mjs  # Error taxonomy & classifier (TRANSIENT, RATE_LIMIT, ACCOUNT_POLICY)
│   ├── executor-ops.mjs               # Operator maintenance & gated recovery functions
│   ├── executor-router.mjs            # Deterministic multi-executor routing pure function
│   ├── executor-runtime-guard.mjs     # Circuit breaker state machine & concurrency slot guard
│   ├── executor-status.mjs            # Global executor capability/availability loader
│   ├── governance.mjs                 # Governance bridge & publish verdict classifier
│   ├── recovery.mjs                   # Crash recovery classifier & executor
│   ├── reviews.mjs                    # Independent code review parser & binder
│   ├── scheduler.mjs                  # Core task state machine
│   ├── store.mjs                      # Atomic filesystem store
│   ├── tasklock.mjs                   # Exclusive task file lock manager
│   └── vault-client.mjs               # MCP Vault Client wrapper
├── tasks/                             # Task JSON file truth directory
├── runtime/                           # Runtime state & sanitized audit events
├── locks/                             # Exclusive execution locks
├── tests/                             # Full automated test suite (91 unit/e2e/prod/invariant tests)
├── FINAL_ARCHITECTURE.md              # Authoritative architectural blueprint
├── EXECUTOR_SAFETY_MODEL.md           # Authoritative executor safety and failure model
├── AGY_INCIDENT_POSTMORTEM.md         # Postmortem and design rationale for runtime guard
├── PERSISTENCE_CHECK.md               # Persistence audit report
├── SECURITY_AUDIT.md                  # Security & credential audit report
├── EXECUTOR_STATUS_MATRIX.md          # Multi-executor capability & status matrix
├── OPERATOR_RUNBOOK.md                # Standard operating procedure manual
├── CHANGE_CONTROL.md                  # Baseline change control protocol
├── DISASTER_RECOVERY.md               # Disaster recovery runbook
└── RELEASE_MANIFEST.md                # This release manifest
```
