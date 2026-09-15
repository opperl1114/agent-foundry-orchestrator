# Incident Postmortem: Google Antigravity (agy) 403 TOS_VIOLATION Incident

**Incident Reference:** INC-20260905-AGY-403  
**Status:** RESOLVED & ARCHITECTURALLY PREVENTED  
**Baseline Date:** 2026-09-06  
**Target Directory:** `/mnt/c/Users/relaret/agent-foundry-orchestrator/`  

---

## 1. 事故概述 (Executive Summary)

2026-09-05，在 Agent Foundry 早期多智能体原型调度运行期间，调用 Google Antigravity CLI (`agy`) 遭遇云端风控阻断，返回 HTTP 403 `TOS_VIOLATION`（`ACCOUNT_DISABLED`），导致 Antigravity 无法继续作为执行器处理任何请求。

本次事故暴露了在缺乏执行器运行时安全防护层（Executor Runtime Safety Layer）的情况下，全自动编排器对大模型 CLI 进程的调用行为特征与服务商风控策略之间产生的剧烈冲突。

系统通过引入 **PHASE 5-A (Runtime Safety Layer)**、**PHASE 5-B (Operations Layer)** 与 **PHASE 5-C (Real Host Safety Validation)**，从架构层面彻底杜绝了同类高频并发与重试雪崩风险。

---

## 2. 根本原因深入分析 (Root Cause Analysis)

本次事故不是单一因素导致的偶发失败，而是以下四个要素叠加形成的系统性共振：

```text
[Consumer OAuth]
      +
[Headless CLI (--print)]
      +
[Multi-Process Concurrency]
      +
[High-Frequency Launch & Retry]
      ↓
Trigger Cloud Anti-Abuse / TOS Anomaly Detection (HTTP 403 TOS_VIOLATION)
```

### 2.1 凭据类型：Consumer OAuth (个人消费者凭据)
* **背景事实**：`agy` 认证依赖个人消费者 Google 账号的 OAuth 凭据，而非具有专属企业 SLA、高 QPS 配额和企业后台保障的 Cloud Service Account / Enterprise API Key。
* **风控特征**：消费级账号在服务商风控模型中属于高敏客群，其设计基线为**单人、交互式、低频次**的前端终端敲击或 IDE 交互。任何偏离自然人行为特征的流量都会迅速累计风险评分。

### 2.2 执行模式：Headless CLI (`--print`)
* **背景事实**：Orchestrator 为实现全自动化调用，使用了 `agy --print` 非交互式参数，直接将生成内容打到标准输出。
* **风控特征**：Headless 模式剥离了所有人类 UI 交互间隔（无按键停顿、无终端渲染排队、无阅读时间）。请求以机器速度瞬时提交，云端行为指纹分析能极高置信度识别出自动化脚本调用。

### 2.3 进程模型：多进程并发 (Multi-Process Concurrency)
* **背景事实**：在早期 Orchestrator 调度下，当同时派发多个 Author 或 Reviewer 任务时，系统未对底层执行器施加物理进程上限控制。
* **风控特征**：多个独立 OS 进程几乎在同一毫秒并发拉起 `agy` 进程，同时发起握手、OAuth 刷新与批量推理请求。这直接打破了单消费者在同一时刻仅可能运行单一会话的现实世界物理假设，触发“异常多地/多端并发活动”警报。

### 2.4 调度节奏：高频启动与重试雪崩 (High-Frequency Launch & Avalanche Retry)
* **背景事实**：早期调度器没有引入启动起搏（Pacing）与智能错误语义分类。
* **风控特征**：
  1. **密集瞬态拉起**：任务完成后立即拉起下一个任务，调用间隔为毫秒级。
  2. **雪崩式无脑重试**：当云端首次返回 403 或限流错误时，由于调度器将所有非零退出码盲目视为可重试瞬态错误，导致编排器在极短时间内发起重试冲击。
  3. **恶性循环**：高频重试反向加剧了风控阈值越界，使临时警告迅速升级为不可逆的账号级 `ACCOUNT_DISABLED`。

---

## 3. 架构级解决方案 (Architectural Resolution)

为了彻底阻断“高频启动”、“多进程并发”与“重试雪崩”，Agent Foundry 在 Orchestrator 核心链路中建立了完备的运行时安全防御体系：

```mermaid
graph TD
    Scheduler["Scheduler (Preflight: Availability & Circuit)"]
    Guard["ExecutorRuntimeGuard"]
    Classifier["ExecutorErrorClassifier"]
    Breaker["Circuit Breaker State Machine"]
    Admin["af-admin Operator CLI"]
    Audit["executor-runtime-events.jsonl"]

    Scheduler -->|1. canExecute?| Guard
    Guard -->|2. Check Circuit| Breaker
    Scheduler -->|3. acquireSlot (Pacing & Parallel Cap)| Guard
    Guard -->|4. Launch Process| RealProcess["Real Executor Process"]
    RealProcess -->|5. Exit & Stderr| Classifier
    Classifier -->|6. Classify: ACCOUNT_POLICY| Guard
    Guard -->|7. Trip Circuit: OPEN_MANUAL_RESET| Breaker
    Guard -->|8. Log Audit Event| Audit
    Admin -->|9. Manual Audit & Reset with --reason| Breaker
```

### 3.1 运行时安全卫士 (Runtime Guard)
在 `lib/executor-runtime-guard.mjs` 中定义了每个执行器的严格物理运行时 Profile（`config/executor-safety-profiles.json`）：
- **并发硬上限 (`max_parallel`)**：
  - 对 `antigravity` 设置物理并发上限 `max_parallel = 1`，彻底杜绝多进程并发。
- **启动起搏节流 (`min_interval_ms`)**：
  - 对 `antigravity` 设置最小启动间隔 `min_interval_ms = 5000`（5秒）。
  - **原子预占位保护**：进入调度排队时首先原子自增 `activeProcesses`，随后强制进入起搏睡眠，防止并发请求在起搏间隔中穿透滑入。

### 3.2 错误分类器与熔断器 (Circuit Breaker & Error Classifier)
- **精准错误分类 (`lib/executor-error-classifier.mjs`)**：
  - 将所有包含 `403`、`TOS_VIOLATION`、`ACCOUNT_DISABLED` 的错误精准收敛判定为 `ACCOUNT_POLICY`。
  - 核心契约：明确返回 `retryable: false`。调度器直接终止重试，绝不发起任何二次调用。
- **状态机硬锁定 (`OPEN_MANUAL_RESET`)**：
  - 一旦触发 `ACCOUNT_POLICY` 或严重凭据故障，熔断器立即切入 `OPEN_MANUAL_RESET` 状态。
  - **预检拦截 (Preflight Interception)**：调度器在拉起进程前调用 `runtimeGuard.canExecute(executor)`。处于熔断开启的执行器直接被拦截，任务置为 `FAILED (EXECUTOR_CIRCUIT_OPEN)`，**实现 0 个 OS 进程拉起**。
  - **持久化阻断**：熔断状态写入 `runtime/executor-safety-state.json`，即使 Orchestrator 重启，熔断状态依然生效，防止服务重启后自动撞墙。

### 3.3 人工介入复位 (Operator Reset via `af-admin`)
- **严禁自动化静默复位**：处于 `OPEN_MANUAL_RESET` 状态的执行器，禁止任何定时器或后台脚本自动恢复，杜绝“先试探一下看封禁解除了没”的高危行为。
- **强制责任归属 (`af-admin circuit reset`)**：
  - 必须由系统管理员在完成上游申诉或确认账号恢复后，显式执行：
    ```bash
    af-admin circuit reset antigravity --reason "Account appeal approved, verified manually in browser"
    ```
  - `--reason` 为必填参数，严禁空理由复位。
- **不可伪造审计日志 (`runtime/executor-runtime-events.jsonl`)**：
  - 所有 `CIRCUIT_OPEN`、`LAUNCH_BLOCKED`、`CIRCUIT_RESET` 均按结构化 JSONL 持久化记录，且严格脱敏，不记录任何 prompt 或凭据。

---

## 4. 宿主安全验证证据 (Verification Evidence)

在 PHASE 5-C 真实宿主验证中，我们执行了针对上述防御机制的黑盒与白盒压力测试，全部获得 PASS 验证：

1. **真实宿主阻断测试**：
   - 验证链路：真实包装器 `/home/relaret/bin/agy-af` 遇到 403 时，Orchestrator 100% 正确捕获并切入 `OPEN_MANUAL_RESET`。
   - 自动化调度重试数：**0 次**（立即终止）。
2. **并发脉冲突刺防护测试**：
   - 模拟 10 个并发任务同时请求 `max_parallel = 1` 的执行器，系统严格按队列串行化拉起，峰值并发进程数恒等于 1，未出现任何资源争抢或多进程竞态。
3. **熔断器预检拦截测试**：
   - 在熔断器打开状态下尝试执行 5 次调度，全部在预检层被阻断，底层真实进程启动数为 **0**，审计日志完整记录 5 条 `LAUNCH_BLOCKED` 事件。
4. **测试套件全绿**：
   - 全量 50 项测试（包含 39 项基线回归 + 6 项 Runtime Safety 测试 + 5 项 Operations 测试）持续保持 **50/50 全量通过**。

---

## 5. 长期运营守则 (Operational Guidelines)

针对后续接入或维护大模型 CLI 执行器，团队必须遵守以下红线：

1. **消费级凭据一律配置单并发与起搏保护**：
   凡使用 Consumer OAuth 认证的执行器，其 Profile 必须强制配置 `max_parallel: 1` 且 `min_interval_ms >= 5000`。
2. **403 / TOS 严禁自动重试**：
   任何涉及 ToS、账号禁用、凭据非法的错误，分类器必须判定 `retryable: false` 与 `OPEN_MANUAL_RESET`。
3. **禁止自动化心跳探测被封账号**：
   严禁编写任何后台定时任务去轮询调用处于封号/熔断中的执行器。
4. **ROLE != PLATFORM 动态规避**：
   当某一执行器（如 Antigravity）因 ToS 不可用时，系统可通过动态角色分配将其任务平滑迁移至其他就绪执行器（如 Claude），不得将系统停摆归咎于单一平台。
