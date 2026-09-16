# Agent Foundry Orchestrator

> **企业级多智能体协同调度与控制核心 (Multi-Agent Task Orchestrator & Control Plane)**  
> 当前版本：`Production Release v1.2 (Full Capabilities)` ｜ 自动化测试状态：**181 / 181 PASS (100%)（干净克隆验证）**

---

## 📖 项目简介 (Overview)

**Agent Foundry Orchestrator** 是专为多大语言模型（LLM）与智能体执行器（Executor）打造的企业级**控制平面调度系统（Control Plane）**。

在传统的单 Agent 开发中，AI 常常面临**幻觉无法自纠、缺乏独立审查、进程崩溃后状态丢失、高危操作缺乏人类意图门禁、多步骤开发冲突相互覆盖、API 封号导致死锁**等工程痛点。

Agent Foundry Orchestrator 构建了一套**高度自主、具备意图门禁防越权、多任务 DAG 拆解、并行 Git Worktree 隔离、以及自动博弈自愈**的生产级控制系统，让多个主流模型在工业级流水线中安全协作。

---

## 🌟 核心能力矩阵 (Key Capabilities)

### 1. 🧭 自主规划与 DAG 分批调度 (Autonomous Planner & DAG Scheduler)
* **Goal 自动拆解**：基于 `planner/` 模块与 Codex Planner，将宏观目标结构化拆解为有序的子任务计划（`task-plan.schema.json`）。
* **DAG 拓扑分批**：自动识别步骤间的依赖关系与并行批次（Batches），无依赖的步骤自动进入并行工作流，有依赖的步骤严格串行交付。

### 2. 🛡️ 人类意图门禁与动作合约 (Human Intent Gate & Action Contract)
* **高危行为拦截**：集成 `intent/` 与 `approval/` 门禁系统。当任务涉及**系统架构变更、核心配置修改、高敏资产写入或大范围代码删除**时，自动触发 `WAITING_HUMAN` 阻断，必须获得人类明确批准方可执行。
* **严格动作合约**：所有智能体行为必须满足 `contracts/action-contract.schema.json` 白名单约束，禁止未经声明的外部副作用。

### 3. 🌲 并行 Git Worktree 隔离沙箱 (Parallel Worktree Isolation)
* **代码修改零冲突**：并行批次中的多个步骤通过 `lib/worktree.mjs` 在独立的 Git Worktree 临时分支中并发执行，完全隔离主工作区。
* **合并与冲突闭锁**：各分支完成后自动 Merge 回主分支；一旦检测到合并冲突（Merge Conflict），系统立即触发 Fail-Closed 并记录冲突上下文，绝不暴力强推。

### 4. 🔄 双模型独立博弈与自愈闭环 (Self-Healing Loop)
* **创作者与独立审查者**：代码由 **Author** 产出，由物理隔离的 **Reviewer** 进行多维度 Review。
* **精确会话恢复 (Exact Resume)**：Reviewer 提出 `NEEDS_FIX` 时，系统自动精准接续原 Author 会话上下文修复，全程零人工传话。
* **确定性验收测试**：验收命令必须命中静态白名单 `config/acceptance-allowlist.json`，并与任务文件完整性哈希绑定（被改写即 fail-closed）；AI 输出绝对不能随意作为 Shell 执行。

### 5. ⚡ 企业级断路器与受控恢复 (Runtime Guard & Gated Recovery)
* **三维状态解耦**：严格分离 **Capability（机制能力）**、**Availability（账号可用性）** 与 **Runtime Safety（并发与熔断）**。
* **403 强闭锁保护**：遭遇 HTTP 403、TOS 违规或封号错误时，断路器自动闭锁为 `OPEN_MANUAL_RESET`，严禁盲目重试。
* **沙箱隔离探活**：通过 `af-admin` 执行隔离沙箱轻量探活（Probe），生成证据后经操作员审核（Admit）方可解除熔断。

### 6. 🔀 多执行器纯函数路由 (Multi-Executor Router)
* **全平台兼容**：原生适配 **Vertex Gemini**（企业级适配器）、**Claude**、**Codex**、**Cline** 与 **Antigravity**。
* **瞬时故障回退**：仅在瞬时网络错误（Transient Fault）或配额限流（Rate Limit）时安全 Fallback。

### 7. 🌍 真正的全平台零依赖可移植性 (Cross-Platform Portability)
* **零硬编码主机路径**：全工程通过 `lib/config.mjs` 实现环境自适应，支持环境变量（`AF_GLOBAL_DIR`, `AF_VAULT_MCP_SERVER`）与当前机器 `$HOME` 自动推导，可在任何 Linux / WSL / Mac 机器上直接克隆运行。
* **纯净出厂状态**：已清理所有历史测试任务与本地日志，默认出厂状态干净整洁。

---

## 🏛️ 核心架构图 (Architecture Overview)

```
                       [ 目标输入 (Goal / Task Capsule) ]
                                      │
                                      ▼
                      ┌──────────────────────────────┐
                      │    任务规划层 (Planner Layer) │
                      │  - 目标拆解为 DAG 步骤序列    │
                      │  - 生成符合 Schema 的 Plan   │
                      └──────────────┬───────────────┘
                                     │
                                     ▼
                      ┌──────────────────────────────┐
                      │ 人类意图门禁 (Intent Gate)    │
                      │  - 评估高危动作与资产敏感度   │
                      │  - 拦截高风险写入 -> 人工审批 │
                      └──────────────┬───────────────┘
                                     │ (Approved / Auto-passed)
                                     ▼
                      ┌──────────────────────────────┐
                      │ 调度控制平面 (Scheduler Core) │
                      │  - 并行分批: Git Worktree 隔离│
                      │  - Author -> Reviewer 博弈闭环│
                      │  - 确定性白名单验收命令执行   │
                      └──────────────┬───────────────┘
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
    ┌──────────────────────────┐            ┌──────────────────────────┐
    │ 运行时守卫 (Runtime Guard)│            │ 知识库网桥 (Gov Bridge)   │
    │  - 并发槽位限制 & 熔断器 │            │  - 仅在治理任务中按需连接 │
    │  - 探活与受控准入 (Probe)│            │  - L2 自动发布 / L3 门禁 │
    └──────────────────────────┘            └──────────────────────────┘
```

---

## 🚀 快速开始 (Quick Start)

### 1. 环境准备
* 运行环境：Node.js >= v20 (推荐 v24)
* 操作系统：Linux / macOS / Windows WSL2

### 2. 环境变量配置（可选）
系统支持自动推导本地路径，也可以通过环境变量指定外部全局配置：
```bash
# 可选：指定外部 agent-foundry-global 规范路径
export AF_GLOBAL_DIR="/path/to/agent-foundry-global"

# 可选：指定外部 vault-mcp 治理服务路径
export AF_VAULT_MCP_SERVER="/path/to/vault-mcp/server.mjs"
```

### 3. 执行任务
使用出厂自带的任务模板快速发起任务：
```bash
# 基于模板创建新任务
cp tasks/task-template.json tasks/my-task.json

# 启动调度器执行
node orchestrator.mjs run --task-file tasks/my-task.json
```

### 4. 运维管理 CLI (`af-admin`)
```bash
# 1. 查看所有执行器状态（能力、可用性、断路器）
node af-admin.mjs executor status

# 2. 查看熔断器列表与冷却状态
node af-admin.mjs circuit list

# 3. 熔断隔离探活与人工准入
node af-admin.mjs executor recovery probe vertex-gemini
node af-admin.mjs executor recovery admit vertex-gemini --evidence <probe_id> --reason "Billing fixed"

# 4. 清理历史任务 (支持 --confirm 执行真正清理)
node af-admin.mjs tasks prune
```

### 5. 崩溃自动接续与恢复 (Crash Recovery)
```bash
# 只读扫描系统中所有待恢复任务
node orchestrator.mjs recover --scan

# 精准恢复指定任务断点
node orchestrator.mjs recover --task-id <task_id>
```

---

## 📂 项目完整结构 (Repository Structure)

```
agent-foundry-orchestrator/
├── orchestrator.mjs                   # 主调度器 CLI、DAG 分批调度与生命周期入口
├── af-admin.mjs                       # 运维管理 CLI
├── bin/                               # 启动器封装
│   ├── af-admin                       # 全局运维命令
│   ├── cline-af                       # 跨平台 Cline CLI 包装器
│   └── vertex-gemini-af               # 企业级 Vertex Gemini 包装器
├── approval/                          # 人类意图门禁 (Human Intent Gate)
│   ├── intent-gate.mjs                # 意图门禁求值引擎
│   └── intent-policy.mjs              # 风险等级与审批策略
├── intent/                            # 动作校验与资产分类
│   ├── action-validator.mjs           # 动作负载校验器
│   └── asset-classifier.mjs           # 资产敏感度分类器
├── contracts/                         # 动作合约 (Action Contract)
│   ├── action-contract.schema.json    # JSON Schema 动作合约
│   └── action-types.json              # 动作类型合约（运行期真源：intent/action-validator.mjs 读取）
├── planner/                           # 任务规划层 (Planner Layer)
│   ├── planner.mjs                    # 规划器引擎与 DAG 分批逻辑
│   └── schema/task-plan.schema.json   # 任务规划 Schema 规范
├── config/                            # 策略配置
│   ├── executor-safety-profiles.json  # 各执行器并发与熔断配置
│   └── operator-executors.json        # 运维动态启停开关 (出厂默认纯净全开)
├── lib/                               # 核心架构模块
│   ├── acceptance.mjs                 # 确定性验收测试执行引擎
│   ├── adapters.mjs                   # 统一执行器适配器 (Claude, Vertex, Codex, Cline, Antigravity)
│   ├── codex-planner.mjs              # Codex 驱动的任务规划适配
│   ├── config.mjs                     # 跨平台统一环境与路径发现层
│   ├── executor-error-classifier.mjs  # 错误分类器 (Transient / RateLimit / AccountPolicy)
│   ├── executor-ops.mjs               # 运维工具与受控恢复核心
│   ├── executor-router.mjs            # 纯函数确定性多执行器路由器
│   ├── executor-runtime-guard.mjs     # 运行时守卫 (断路器状态机、并发槽位、日志清洗)
│   ├── executor-status.mjs            # 执行器能力与可用性状态投影器
│   ├── governance.mjs                 # 知识库治理网桥 (GovernanceBridge)
│   ├── operator-control.mjs           # 运行时拦截器与用户消息热注入
│   ├── recovery.mjs                   # 宕机断点恢复分析与执行引擎
│   ├── reviews.mjs                    # 独立 Reviewer 结果解析与绑定
│   ├── scheduler.mjs                  # 任务状态机驱动核心
│   ├── store.mjs                      # POSIX 原子文件持久化存储
│   ├── tasklock.mjs                   # 基于文件系统的排他互斥锁与死锁回收
│   ├── vault-client.mjs               # MCP Vault 治理客户端
│   ├── workbench.mjs                  # 开发者工作台控制与体验注入
│   └── worktree.mjs                   # Git Worktree 并发分支创建与安全合并
├── tasks/                             # 任务持久化目录 (出厂纯净: task-template.json + .gitkeep)
├── runtime/                           # 运行时状态与安全策略 (出厂纯净: 零日志)
├── locks/                             # 进程互斥排他锁目录
└── tests/                             # 全量自动化测试套件 (181 个用例全部通过)
```

---

## 🧪 自动化测试套件 (Test Suite)

运行全量测试套件：
```bash
node --test
```

**测试矩阵全绿通过 (181 / 181 PASS, 100%) （干净克隆 `git clone . && node --test`）**：
* 🌲 **Git Worktree 并发与合并冲突**：多分支隔离并行写入、冲突检测安全 Fail-Closed；
* 🧭 **Planner 规划层契约**：DAG 分批有效性、规划器与执行器职责隔离边界；
* 🛡️ **Human Intent Gate 意图门禁**：高危写操作拦截、删除阻断、人工通过接续；
* 🔄 **Author-Reviewer 双模型博弈**：结构化 Review 循环、精确会话接续 (Exact Resume)；
* ⚡ **运行时安全与断路器**：403 强闭锁、限流退避、沙箱隔离探活 (Probe) 与准入 (Admit)；
* 🛑 **优雅停机与进程防孤儿**：SIGTERM 信号回收、活跃子进程终止、零孤儿句柄；
* 🏛️ **架构不变性**：单注册表真源检验、单调度器检验、防凭据落盘检测、`ROLE != PLATFORM` 检验。

---

## 📚 详细规范文档索引 (Documentation Index)

* 🏛️ [架构终态设计蓝图 (`FINAL_ARCHITECTURE.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/FINAL_ARCHITECTURE.md)
* 🛡️ [执行器安全与熔断模型 (`EXECUTOR_SAFETY_MODEL.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/EXECUTOR_SAFETY_MODEL.md)
* 📖 [生产运维标准操作手册 (`OPERATOR_RUNBOOK.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/OPERATOR_RUNBOOK.md)
* 🚨 [生产灾难恢复操作手册 (`DISASTER_RECOVERY.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/DISASTER_RECOVERY.md)
* 📋 [生产冻结发布清单 (`RELEASE_MANIFEST.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/RELEASE_MANIFEST.md)
* 🔒 [基线变更控制协议 (`CHANGE_CONTROL.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/CHANGE_CONTROL.md)
* 🔍 [持久化与安全审计报告 (`PERSISTENCE_CHECK.md` / `SECURITY_AUDIT.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/SECURITY_AUDIT.md)
