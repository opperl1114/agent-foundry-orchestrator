# Agent Foundry Executor Safety Model: Capability vs Availability vs Runtime State

**Document Status:** CANONICAL REFERENCE  
**Target Audience:** Orchestrator Developers, Platform Engineers, System Operators  
**Baseline Date:** 2026-09-06  

---

## 1. 核心定义与设计理念 (Design Philosophy)

在复杂多执行器编排系统（Multi-Executor Orchestration System）中，最致命的架构反模式之一是将**“工具能做什么”**、**“当前能否使用”**与**“当前是否安全”**混为一谈。

当 Google Antigravity 账号因 ToS 403 被封禁时：
* 它是一个能力缺陷吗？**不是**。Antigravity 的 `--print`、`--json-schema`、`--conversation` 等参数机制依然完全正常，版本能力未发生任何退化。
* 它可以被 Scheduler 调度执行吗？**不能**。由于缺少有效的凭据与云端许可，任何调度尝试都只会产生失败。
* 它可以不断自动重试吗？**绝不能**。如果缺乏运行时安全门禁，系统会自动发起数十次并发重试，导致服务商风控直接升级为永久账号封停。

为了彻底根除此类风险，Agent Foundry Orchestrator 建立了严密的三层语义分离模型：

```text
+-------------------------------------------------------------------------+
| 1. Capability Truth (静态能力真相)                                      |
| 来源: agent-foundry-global/executors/*.json                             |
| 语义: 机制审计证明的潜在能力 (What the CLI mechanism CAN do)            |
+-------------------------------------------------------------------------+
                                   ↓
+-------------------------------------------------------------------------+
| 2. Availability Truth (系统可用性真相)                                  |
| 来源: lib/executor-status.mjs                                           |
| 语义: 外部环境事实与账号状态投影 (Can it be STARTED right now)           |
+-------------------------------------------------------------------------+
                                   ↓
+-------------------------------------------------------------------------+
| 3. Runtime Safety State (运行时安全状态与观察)                          |
| 来源: lib/executor-runtime-guard.mjs & executor-safety-state.json       |
| 语义: 动态并发管控、起搏节流与熔断器 (Is it SAFE to launch at this moment)|
+-------------------------------------------------------------------------+
```

---

## 2. 三维模型深度对比 (The Three-Tier Matrix)

| 维度 | 1. Capability (能力) | 2. Availability (可用性) | 3. Runtime State (运行时安全) |
| :--- | :--- | :--- | :--- |
| **关注核心** | 机制可行性 (Mechanisms) | 环境准入性 (Admissibility) | 调用动态安全 (Invocation Safety) |
| **权威事实源** | `agent-foundry-global/executors/*.json` | `lib/executor-status.mjs` | `runtime/executor-safety-state.json` |
| **维护方式** | 静态工程审计（版本锁定、人工评测） | 基于 `blockers` 字段的只读函数式派生 | `ExecutorRuntimeGuard` 内存与磁盘持久化 |
| **典型状态值** | `READY`, `PARTIAL`, `BLOCKED`, `UNKNOWN` | `AVAILABLE`, `UNAVAILABLE` (`ACCOUNT_DISABLED_403`, `EXECUTOR_BLOCKED`) | `CLOSED`, `OPEN_MANUAL_RESET`, `OPEN_COOLDOWN`, `HALF_OPEN` |
| **生命周期** | 长期稳定（随 CLI 大版本更新演进） | 中期（随账号封停/解封、依赖安装而变） | 短期/瞬态（随每次进程调用、故障分类动态流转） |
| **变更驱动** | 机制审计测试重新评定 | 外部审计更新 `blockers` 事实记录 | 进程退出码、错误分类器判定、Operator CLI 手动复位 |
| **能否被报错改变**| **绝对禁止**（不能因报错降级机制） | **不直接改变**（需外部事实确认） | **自动实时更新**（403 直接触发熔断开启） |
| **能否自动恢复** | 不涉及恢复概念 | 不涉及自动恢复 | `OPEN_COOLDOWN` 随时间到期恢复；`OPEN_MANUAL_RESET` **严禁自动恢复** |

---

## 3. 各执行器实况状态矩阵 (Live State Matrix)

以当前 Agent Foundry 系统中配置的 3 大执行器为例：

### 3.1 Antigravity (`antigravity` / `agy`)
* **Capability:** `READY`  
  *事实依据*：经 Phase 2C 严格黑盒验证，其非交互式 `--print`、结构化 `--json-schema`、精确会话恢复 `--conversation <id>`、无干预 MCP 工具调用机制全部测试通过（PASS）。
* **Availability:** `UNAVAILABLE` (`ACCOUNT_DISABLED_403`)  
  *事实依据*：上游 Google 服务于 2026-09-05 标记 ToS 403 封禁，`blockers` 包含明确的账号级禁用事实，调度器排他性将其排除在全自动调度之外。
* **Runtime State:** `OPEN_MANUAL_RESET`  
  *安全状态*：熔断器打开，强行阻断所有调用；`retryable = false`；必须由 Operator 手动复位。

### 3.2 Claude (`claude`)
* **Capability:** `READY`  
  *事实依据*：Headless `--print`、JSON 提取、会话恢复 `--resume <session_id>` 经长期生产审计全部 PASS。
* **Availability:** `AVAILABLE`  
  *事实依据*：无任何 blockers，账号及 API 调用正常。
* **Runtime State:** `CLOSED`  
  *安全状态*：熔断器闭合，允许在 `max_parallel = 2`、`min_interval_ms = 1000` 保护下安全调度。

### 3.3 Codex (`codex`)
* **Capability:** `PARTIAL`  
  *事实依据*：Codex 0.147.0 不支持无干预 MCP 工具调用（`BLOCKED_BY_EXECUTOR_APPROVAL`），仅具备单步代码生成能力。当任务标记 `requires_mcp: true` 时在调度器层被排除。
* **Availability:** `AVAILABLE`  
  *事实依据*：CLI 二进制存在，本地环境就绪。
* **Runtime State:** `CLOSED`  
  *安全状态*：熔断器闭合，允许在 `max_parallel = 1`、`min_interval_ms = 2000` 保护下调度普通任务。

---

## 4. 调度与拦截决策流 (Decision Pipeline)

当调度器处理一个任务时，按顺序穿透三道防线：

```text
[Task Enqueued]
       │
       ▼
[1. Capability Check] (Can the executor satisfy task parameters?)
       │  例如: task_requires_mcp == true -> codex 被剔除
       ├─ (No) ──> 任务标记 FAILED (CAPABILITY_MISMATCH)
       ▼ (Yes)
[2. Availability Preflight] (Is the executor accessible right now?)
       │  例如: antigravity availability == UNAVAILABLE -> 拦截
       ├─ (No) ──> 任务标记 FAILED (EXECUTOR_UNAVAILABLE), 零进程启动
       ▼ (Yes)
[3. Runtime Safety Gate] (Is the circuit breaker CLOSED / canExecute?)
       │  例如: circuit_state == OPEN_MANUAL_RESET -> 拦截
       ├─ (No) ──> 任务标记 FAILED (EXECUTOR_CIRCUIT_OPEN), 记录 LAUNCH_BLOCKED
       ▼ (Yes)
[4. Concurrency & Pacing Slot] (acquireSlot)
       │  等待 activeProcesses < max_parallel
       │  原子占用槽位 -> 等待 min_interval_ms 起搏
       ▼
[5. Real Process Spawn]
       │  执行 OS 子进程
       ▼
[6. Error Classification & Feedback]
       ├── SUCCESS           ──> 释放槽位, HALF_OPEN 转 CLOSED
       ├── RATE_LIMIT (429)  ──> 释放槽位, 触发 OPEN_COOLDOWN (临时冷却)
       ├── ACCOUNT_POLICY (403) ──> 释放槽位, 触发 OPEN_MANUAL_RESET (人工复位锁定)
       └── TRANSIENT_FAULT   ──> 释放槽位, 允许 Scheduler 有界重试
```

---

## 5. 治理红线总结 (Safety Invariants)

1. **绝对禁止降级伪造**：不得把 403 伪装成临时网络错误，不得把 `ACCOUNT_POLICY` 伪装成 `TRANSIENT_FAULT`。
2. **绝对禁止静默探活**：处于 `OPEN_MANUAL_RESET` 状态的执行器，禁止系统在后台尝试“发个测试请求试一下”，必须保持物理零调用。
3. **权威不可僭越**：运行时安全层（Runtime Safety）仅管理调用节奏与熔断保护，绝对不作为第二注册表，不可越权修改静态能力定义。
