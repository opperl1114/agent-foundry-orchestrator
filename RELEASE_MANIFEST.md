# Agent Foundry Orchestrator - Release Manifest

## Release Overview

| Attribute | Specification |
| :--- | :--- |
| **Release Name** | Agent Foundry Orchestrator Production Release v1.2 (Full Capabilities) |
| **Frozen At** | 2026-09-15T22:30:00+08:00 |
| **Architecture Reference** | [`FINAL_ARCHITECTURE.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/FINAL_ARCHITECTURE.md) |
| **Safety Model Reference** | [`EXECUTOR_SAFETY_MODEL.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/EXECUTOR_SAFETY_MODEL.md) |
| **Regression Test Status** | **146 / 146 PASS (100%)** |
| **Execution Engine** | Multi-step DAG state machine (`orchestrator.mjs` + `lib/scheduler.mjs` + `lib/worktree.mjs`) |
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
| **PHASE 9** | Multi-Executor Extension (Cline) | Native Cline CLI adapter (`bin/cline-af`), DeepSeek-V4-Flash fallback support, health/resume/run integration. |
| **PHASE 10** | Human Intent Gate & Action Contract | `intent/` + `approval/` + `contracts/`: Action Validator, Asset Classifier, Intent Policy, sensitive operation blocking. |
| **PHASE 11** | Autonomous Planning Layer | `planner/` + `lib/codex-planner.mjs`: Task decomposition, DAG batching, `task-plan.schema.json`, planner boundary invariants. |
| **PHASE 12** | Worktree & Workbench Sandbox | `lib/worktree.mjs` + `lib/workbench.mjs`: Multi-step DAG execution in parallel Git worktrees, conflict fail-closed detection. |
| **PHASE 13** | Host Decoupling & Clean Release | `lib/config.mjs`: Elimination of 94 hardcoded host paths, dynamic environment resolution, clean factory state reset. |

---

## Core Runtime Guarantees

1. **ROLE != PLATFORM**:
   - Platforms (`codex`, `claude`, `antigravity`, `vertex-gemini`, `cline`) are strictly execution adapters.
   - Roles (`author`, `reviewer`, `verifier`, `worker`, `planner`) are dynamic attributes assigned per Task Capsule.
   - No executor is hardcoded to any task role.
2. **Governance Single Source of Truth**:
   - All formal knowledge governance decisions derive solely from `agent-foundry-vault` via `vault-mcp`.
   - The Orchestrator never computes, fakes, or relaxes governance policy locally.
3. **Human Intent Gate Protection**:
   - Sensitive modifications (schema changes, system config, destructive deletes, plan direction shifts) require explicit human approval via `approval/intent-gate.mjs`.
4. **Capability / Availability / Runtime Safety Separation**:
   - **Capability**: Statically defined in `agent-foundry-global/executors/*.json` (e.g. MCP support, terminal support).
   - **Availability**: Dynamically tracked based on provider account standing (e.g. `ACCOUNT_DISABLED`, `UNAVAILABLE`).
   - **Runtime Safety**: Managed in-memory and persisted by `ExecutorRuntimeGuard` (concurrency slot, circuit breaker).
5. **Fail-Closed Principle**:
   - Any fatal policy violation (`ACCOUNT_POLICY`, 403 Forbidden, TOS violation) immediately trips the circuit to `OPEN_MANUAL_RESET`.
   - Under fatal errors, automatic retries are strictly 0, router fallback is strictly forbidden, and the task halts fail-closed.
6. **Parallel Worktree Isolation**:
   - Multi-step DAG tasks execute concurrent branches in isolated Git worktrees (`lib/worktree.mjs`), with automatic conflict detection failing closed safely.
7. **Cross-Platform Portability**:
   - Zero hardcoded author host paths. All paths are resolved via `lib/config.mjs` using environment variables (`AF_GLOBAL_DIR`, `AF_VAULT_MCP_SERVER`), relative discovery, and dynamic `HOME` inference.
8. **Zero Credential Persistence**:
   - The Orchestrator never writes API keys, tokens, auth headers, passwords, or raw prompts/responses to disk.

---

## File Manifest & Component Baseline

```
agent-foundry-orchestrator/
├── orchestrator.mjs                   # Main Orchestrator CLI, DAG Multi-step & Lifecycle Entry
├── af-admin.mjs                       # Operator Administration CLI
├── bin/                               # CLI Wrappers
│   ├── af-admin                       # Global CLI wrapper
│   ├── cline-af                       # Portable Cline launcher with canonical AGENTS.md injection
│   └── vertex-gemini-af               # Enterprise Vertex Gemini launcher
├── approval/                          # Human Intent Gate
│   ├── approval-schema.json           # Gate approval data schema
│   ├── intent-gate.mjs                # Intent gate evaluation engine
│   └── intent-policy.mjs              # Risk policy rules
├── intent/                            # Intent & Asset Classification
│   ├── action-validator.mjs           # Action payload validator
│   └── asset-classifier.mjs           # Sensitive asset classifier (gov, config, schema, code)
├── contracts/                         # Action Contracts
│   ├── action-contract.schema.json    # JSON Schema for agent actions
│   └── action-types.json              # Whitelist of permissible action types
├── planner/                           # Autonomous Task Planning
│   ├── planner.mjs                    # Goal decomposition & DAG batch scheduler
│   └── schema/task-plan.schema.json   # Plan schema specification
├── config/                            # Runtime Policy & Restrictions
│   ├── executor-safety-profiles.json  # Safety profiles per executor
│   └── operator-executors.json        # Operator executor dynamic override (factory clean: empty)
├── lib/                               # Core Architectural Modules
│   ├── acceptance.mjs                 # Acceptance command whitelist & sandbox execution
│   ├── adapters.mjs                   # Unified Executor Adapters (Claude, Vertex, Codex, Cline, Antigravity)
│   ├── codex-planner.mjs              # Codex-driven planner interface
│   ├── config.mjs                     # Cross-platform environment & path discovery
│   ├── executor-error-classifier.mjs  # Error taxonomy (TRANSIENT, RATE_LIMIT, ACCOUNT_POLICY)
│   ├── executor-ops.mjs               # Operator maintenance & gated recovery functions
│   ├── executor-router.mjs            # Deterministic multi-executor routing pure function
│   ├── executor-runtime-guard.mjs     # Circuit breaker state machine & slot concurrency guard
│   ├── executor-status.mjs            # Executor capability & availability status loader
│   ├── governance.mjs                 # Governance bridge & publish verdict classifier
│   ├── operator-control.mjs           # Dynamic executor restrictions & user message injection
│   ├── recovery.mjs                   # Idempotent crash recovery classifier & executor
│   ├── reviews.mjs                    # Independent code review parser & binder
│   ├── scheduler.mjs                  # Core task state machine
│   ├── store.mjs                      # POSIX atomic filesystem store
│   ├── tasklock.mjs                   # Exclusive task file lock manager
│   ├── vault-client.mjs               # MCP Vault Client wrapper
│   ├── workbench.mjs                  # Developer workbench prompt & experience control
│   └── worktree.mjs                   # Git worktree parallel execution & DAG batch merging
├── tasks/                             # Task JSON directory (factory clean: task-template.json + .gitkeep)
├── runtime/                           # Runtime state & policies (factory clean: zero logs)
├── locks/                             # Exclusive execution locks (.gitkeep)
├── tests/                             # Automated test suite (146 tests, 100% passing)
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
