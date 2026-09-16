# Agent Foundry Orchestrator - Release Manifest

## Release Overview

| Attribute | Specification |
| :--- | :--- |
| **Release Name** | Agent Foundry Orchestrator Production Release v1.2 (Full Capabilities) |
| **Frozen At** | 2026-09-15T22:30:00+08:00 |
| **Architecture Reference** | [`FINAL_ARCHITECTURE.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/FINAL_ARCHITECTURE.md) |
| **Safety Model Reference** | [`EXECUTOR_SAFETY_MODEL.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/EXECUTOR_SAFETY_MODEL.md) |
| **Regression Test Status** | **182 / 182 PASS (100%)** — verified on a CLEAN CLONE (`git clone . /tmp/verify && node --test`), not only on the author's checkout |
| **Last Hardened At** | 2026-09-16 (see Post-freeze Hardening below) |
| **Execution Engine** | Multi-step DAG state machine (`orchestrator.mjs` + `lib/scheduler.mjs` + `lib/worktree.mjs`) |
| **Storage Architecture** | Filesystem atomic rename (`saveTaskAtomic`), zero SQLite/Postgres/Redis dependencies |

---

## Post-freeze Hardening (B0 / B1)

The v1.2 baseline was green only on the author's machine. A clean clone registered
133 of 146 tests and failed 15 of them, so the recorded "146 / 146" could not be
reproduced. Batches B0 (make the baseline trustworthy) and B1 (five critical
safety defects) were applied on top of it.

**B0 — trustworthy baseline**

| Commit | Change |
| :--- | :--- |
| `c55daf0` | Restore executable bits on the 9 shebang-carrying launchers/scripts — a clean clone had none, so every direct `spawn(argv[0])` failed with EACCES. |
| `0b94436` | Stop tracking `runtime/scheduler.json` (per-instance state; every test run left the worktree dirty). |
| `ded6285` | Make asset classification cwd-independent: resolve relative targets against an explicit base root and decide TEMP_CACHE from the target's own path, not from an ancestor directory. |
| `9ecb08c` | Add `fixtures/gateway/` — the conversation-gateway tests hard-imported the sibling gateway repo and died at load time without it (15 cases never registered). |
| `a51745d` | Add `fixtures/agent-foundry-global/executors/` and drive the adapter-contract tests through stub launchers, so the capability and 6A/CLINE cases no longer need the registry or the signed-in provider CLIs. |

**B1 — critical safety defects**

| Commit | Change |
| :--- | :--- |
| `c9a43c3` | A 403/ToS refusal reported on stdout is `ACCOUNT_POLICY` again (codex reports on stdout with an empty stderr), instead of a retryable transient fault that never opened the breaker. |
| `f9b8fb7` | Unify cancellation: codex/antigravity/claude cancelled through `terminateRun`, so a cancelled run was classified retryable and the task could be re-run or FAILED-overwritten. A cancellation is now sticky. |
| `6892f12` | A publish counts only when the vault says `published === true` / `published_path`; `policy_decision: auto_publish` is a strategy class, not an outcome, and no longer completes a task. |
| `2a9b7d4` | Enforce a real acceptance allowlist (`config/acceptance-allowlist.json`), bind the acceptance anchor so an edited task file fails closed as `TASK_FILE_TAMPERED`, scrub the acceptance child's environment, and refuse a workspace inside the orchestrator root. |
| `dfcccc3` | Circuit state is written atomically and an unreadable state file now fails CLOSED (every breaker opens, evidence quarantined, `STATE_CORRUPTION` audited) instead of silently reopening them. |

**Verified after B1** (clean clone, Node v24):

```text
ℹ tests 171
ℹ pass 171
ℹ fail 0
ℹ skipped 0
```

`git status --porcelain` is empty after a full run, and the plan's acceptance
probes now read:

```text
corrupt state file        -> OPEN_MANUAL_RESET / canExecute=false   (was CLOSED / true)
403 on stdout             -> ACCOUNT_POLICY / retryable=false       (was TRANSIENT_FAULT)
auto_publish+published:false -> unknown                             (was published)
```

**B2 — source-of-truth consistency and recovery correctness**

| Commit | Change |
| :--- | :--- |
| `6dd4e88` | Per-executor policy is deep merged (antigravity kept losing its 1h cooldown), cooldown_until is epoch ms everywhere and compared in ms, a guard refusal is `ENVIRONMENT_FAULT` rather than a fabricated `ACCOUNT_POLICY`, codex forwards its purpose so a recovery probe can acquire a slot, the cline fallback no longer auto-resets the breaker, and log rotation no longer drops events appended while it read the file. |
| `3c4a755` | The CLI `run`/`resume` take the task lock; the staged author content is bound to its revision (a crashed fix no longer resumes on the previous revision's content) with a dedicated `FIX_RUNNING` state; acceptance reuse is content-addressed; lock renewal is atomic with an ownership re-check; every lifecycle write goes through one version-incrementing writer (`saveTaskWithVersion`), which required validating the stale-recovery plan BEFORE recovery writes its own bookkeeping; a failed parallel batch cancels sibling runs before tearing down worktrees; `tasksDir` is forwarded to the continuation. |
| `d33d09e` | All author-machine hardcoded paths removed from `lib/config.mjs` and `bin/cline-af` (env -> sibling -> `$HOME`; an unreadable canonical fails closed), and a missing capability registry now fails CLOSED: the router returns `primary: null` / `EXECUTOR_REGISTRY_MISSING` and the scheduler's preflight refuses the task, instead of silently routing as if every executor's state were known. |

**Verified after B2** (clean clone, Node v24):

```text
ℹ tests 182
ℹ pass 182
ℹ fail 0
ℹ skipped 0
```

The plan's §5 checklist now passes end to end, including the two items that had
never passed: `grep -rn '/mnt/c/Users/relaret\|/home/relaret' lib/ bin/ config/`
returns 0, and `AF_EXECUTORS_DIR=/nonexistent` yields an explicit
`EXECUTOR_REGISTRY_MISSING` refusal instead of a silently green suite.

**B3 — minors and engineering hygiene**

| Commit | Change |
| :--- | :--- |
| `74ef9c9` | N1–N13 and E1–E5. Correctness: the cancel CLI path referenced an undeclared `now`; `settleIfPublished` cleared a published flag on ANY error (including a misconfigured bridge) instead of only on a vault rejection; `execAsync` wrapped an async executor in `new Promise`, so a throw after the first await left the promise forever pending; 'error'+'close' double-recorded breaker evidence; codex/cline `health()` could never report `ok: false`; the codex planner could die on an unhandled EPIPE; `ensureGitRepo` silently `git init`-ed any directory and rewrote its commit identity; the shipped task template could not run at all and the acceptance command was only validated after the expensive stages; a failed lease renewal was swallowed, leaving a run executing without its lock. Hardening: the credential scan is recursive with a broader pattern and the audit sanitizer now strips nested credential keys; PROD-2 exercises the real classifier instead of asserting its own baked-in literal; `saveTaskAtomic` fsyncs the file and the directory. Hygiene: `.gitattributes`, `package.json` (`npm test`), a CI regression gate, the duplicate safety-policy file removed (single source) with an explicit cline policy, and `contracts/action-types.json` is now genuinely the runtime source the validator reads. |

**Verified after B3** (clean clone, Node v24, via `npm test`):

```text
ℹ tests 182
ℹ pass 182
ℹ fail 0
ℹ skipped 0
```

The plan's §5 checklist passes end to end on the clean clone, including the two
items that had never passed: `grep -rn '/mnt/c/Users/relaret\|/home/relaret' lib/
bin/ config/` returns 0, and `AF_EXECUTORS_DIR=/nonexistent` yields an explicit
`EXECUTOR_REGISTRY_MISSING` refusal instead of a silently green suite.

Not verified locally: the CI workflow itself (`.github/workflows/regression.yml`)
has no runner here. Its steps are the same commands that were run by hand above;
it is the one artefact in this batch that has not been executed end to end.

**Follow-up on the observations logged during B2/B3**

| Commit | Change |
| :--- | :--- |
| `4f800a7` | Cancellation race: a cancel landing between "run id announced" and "process registered" found no handle and terminated nothing, so the process ran to completion behind a task already marked CANCELLED; the recorded request is now honoured the moment the child exists. Blocked fallback: a cline fallback refused by the breaker reported the circuit refusal as the outcome, hiding the quota refusal that actually failed - the root cause is returned with a `fallback_blocked` record. |
| `4bb5448` | Isolating the repository's `tasks/` directory for tests: `approval/intent-gate.mjs` now honours `AF_TASKS_DIR`, nine test files import the isolation fixture, and governance TEST F-gov forges its task where the module under test actually reads. The 136 historical leftovers were archived to `~/DSHWorkSpace/afr-tasks-leftovers-<ts>.tar.gz` and removed. |

**Follow-up verification** (fresh clone, `npm test`):

```text
ℹ tests 182
ℹ pass 182
ℹ fail 0
ℹ skipped 0
```

`tasks/` holds `task-template.json` before and after the run, and
`git status --porcelain` is empty.

---


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
├── tests/                             # Automated test suite (182 tests, 100% passing on a clean clone)
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
