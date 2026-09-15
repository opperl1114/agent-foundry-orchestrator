# EXECUTOR_STATUS_MATRIX.md — 执行器全生命周期状态矩阵

本文件记录 Agent Foundry Orchestrator 接入的所有执行器在开箱能力（Capability）、可用性（Availability）和运行时安全（Runtime Safety）三层维度的基线状态审计矩阵。

---

## 1. 全局执行器状态矩阵

| Executor ID | Capability (开箱机制能力) | Availability (当前可用性) | Runtime Safety (运行时熔断状态) | 生产调度准入判定 |
|---|---|---|---|---|
| **antigravity** | `READY` | `UNAVAILABLE` (`ACCOUNT_DISABLED_403`) | `OPEN_MANUAL_RESET` | **严禁调度**（前置预检直接拦截；运行时熔断物理锁闭；需人工申诉解封后通过 `af-admin executor recovery probe` / `admit` 恢复） |
| **claude** | `READY` | `AVAILABLE` | `CLOSED` | **允许调度**（支持 Author、Reviewer、Fix 动态角色分配；支持非交互式运行与 MCP 工具调用） |
| **vertex-gemini** | `READY` | `AVAILABLE` | `CLOSED` | **允许调度**（企业级 Enterprise Adapter；无头执行、结构化响应与会话恢复全 PASS） |
| **codex** | `PARTIAL` | `UNAVAILABLE` (`EXECUTOR_BLOCKED`) | `CLOSED` | **受限/不予无人值守调度**（0.147.0 版本的无头 MCP 审批机制受阻，仅支持交互式代码生成，不适用于无人值守流程） |

---

## 2. 状态分层概念与区别说明

根据 [`EXECUTOR_SAFETY_MODEL.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/EXECUTOR_SAFETY_MODEL.md) 的核心规范：

1. **Capability（机制能力）**：
   - 唯一真源：`agent-foundry-global/executors/<executor>.json` 中的 `capabilities_audit`。
   - 关注执行器软件机制（如无头 CLI、结构化输出、会话恢复、MCP 挂载）是否成熟。
   - 账号被封禁或配额耗尽**绝不降低** Capability（例如 Antigravity 即使遭遇 403，其能力评级依然是 `READY`）。
2. **Availability（环境/账号可用性）**：
   - 动态映射：`agent-foundry-global/executors/<executor>.json` 中的 `blockers` 字段与运行时环境探针。
   - 关注“当前环境这一分钟内是否允许启动该执行器”。若存在账号 ToS 封锁或网络不可达，Availability 标记为 `UNAVAILABLE`。
   - 调度器在任务分配前执行 `#preflight` 预检，若目标执行器处于 `UNAVAILABLE`，直接任务内失败，**绝不尝试发起真实进程启动**。
3. **Runtime Safety（运行时安全熔断）**：
   - 唯一真源：`runtime/executor-safety-state.json` 与 `lib/executor-runtime-guard.mjs`。
   - 关注执行器在高频并发、突发速率限制（Rate Limit）、账号安全警报下的进程防击穿保护。
   - 状态包含：`CLOSED`、`OPEN_COOLDOWN`、`HALF_OPEN`、`OPEN_MANUAL_RESET`。
   - 针对 `ACCOUNT_POLICY` 级故障，强行触发 `OPEN_MANUAL_RESET`，仅能通过操作员明确的恢复流程（Recovery Probe -> Manual Admit）方可重置为 `CLOSED`。

---

## 3. 架构铁律：ROLE != PLATFORM

在 Agent Foundry 体系中：
- 平台（Platform/Executor）仅仅是执行器载体（Worker Process）；
- 角色（Task Role，如 `author`、`reviewer`、`verifier`）完全由任务胶囊（Task Capsule）动态指定；
- **禁止任何代码将 Claude 绑定为永久 Reviewer，或将 Vertex 绑定为永久 Author**；
- 矩阵中的任何处于健康状态的执行器均可在不同任务中动态承担 Author 或 Reviewer 职责（在 `TEST 6A-5` 与 `TEST 6C-5` 中已获完全证明）。
