# Agent Foundry Orchestrator

> **企业级多智能体协同调度与控制核心 (Multi-Agent Task Orchestrator & Control Plane)**  
> 当前版本：`Production Freeze v1` ｜ 自动化测试状态：**91 / 91 PASS (100%)**

---

## 📖 项目简介 (Overview)

**Agent Foundry Orchestrator** 是专为多大语言模型（LLM）与智能体执行器（Executor）打造的企业级**控制平面调度系统（Control Plane）**。

在传统的单 Agent 开发中，AI 常常面临**幻觉无法自纠、缺乏独立审查、进程崩溃后状态丢失、API 封号导致系统卡死**等痛点。Agent Foundry Orchestrator 通过纯基于文件系统的轻量级确定性状态机，构建了一套**高度自主、具备自愈与博弈能力、严格安全隔离**的多 Agent 协作与验收闭环。

---

## 🌟 核心特性 (Key Features)

### 1. 🔄 自动博弈与自愈闭环 (Self-Healing Loop)
* **双模型独立博弈**：任务由 **Author（创作者）** 编写，并由物理隔离的 **Reviewer（审查者）** 执行严格的结构化代码审查（`PASS` / `NEEDS_FIX`）。
* **精确会话恢复 (Exact Resume)**：当 Reviewer 提出修改意见时，系统自动接续原 Author 的会话上下文（Session Ref）进行精准修复，杜绝上下文丢失。
* **零人工传话**：整个 Author -> Review -> Fix -> Re-Review 循环全自动推进，无需人类在多个模型之间复制粘贴提示词。

### 2. 🛡️ 确定性验收门禁 (Deterministic Acceptance Gate)
* **防越权执行**：验收测试命令仅来源于静态任务定义中的白名单，**大模型的输出绝对不能直接转化为终端执行命令**。
* **最大重试上限**：设置严格的重试预算（Max Revisions，默认 3 次），避免死循环消耗 Token 配额。

### 3. ⚡ 企业级断路器与受控恢复 (Runtime Guard & Gated Recovery)
* **三维状态解耦**：严格分离 **Capability（机制能力）**、**Availability（账号/环境可用性）** 与 **Runtime Safety（并发与熔断）**。
* **Fail-Closed 闭锁保护**：当遭遇 HTTP 403 Forbidden、违规（TOS Violation）或封号错误时，断路器自动闭锁为 `OPEN_MANUAL_RESET`，**严禁静默重试与降级**。
* **受控准入流程**：通过 `af-admin` 执行沙箱隔离轻量探活（Probe），生成凭证后经操作员确认（Admit）方可解除熔断。

### 4. 🔀 智能多执行器路由 (Multi-Executor Router)
* **确定性漏斗算法**：基于纯函数根据任务能力需求、执行器可用性、熔断状态和优先级进行排序。
* **主流模型适配**：已接入 **Vertex Gemini**（企业级适配器）、**Claude**、**Codex**、**Cline** 与 **Antigravity**。
* **透明降级 (Fallback)**：仅在遭遇网络瞬时波动（Transient Fault）或配额限流（Rate Limit）时安全回退到备选执行器。

### 5. 🛑 优雅停机与进程防孤儿 (Graceful Shutdown)
* **信号感知回收**：完整监听 `SIGINT` (Ctrl+C) 与 `SIGTERM`。主调度器退出时，主动递归清理所有活跃的子进程树与临时句柄，彻底杜绝僵尸进程。

### 6. 💾 零依赖文件级原子存储 (Atomic File Store)
* **无需数据库**：不依赖 PostgreSQL、MySQL 或 Redis。
* **零半状态保证**：任务状态持久化采用同目录原子重命名（POSIX Atomic Rename），确保并发读取时绝不出现 JSON 截断或脏读。
* **进程互斥锁**：基于 `O_CREAT | O_EXCL` 文件排他锁，支持心跳刷新与 Dead PID 自动回收。

---

## 🏛️ 核心架构与设计哲学 (Architecture & Principles)

### 1. `ROLE != PLATFORM` (全局首要原则)
* **平台是执行器 (Executor)**：Claude、Gemini、Codex 仅仅是执行代码的底层工人。
* **角色是任务属性 (Task Role)**：Author、Reviewer、Verifier 由任务定义动态注入。
* **动态分配**：同一个模型平台可以在任务 A 中担任 Author，在任务 B 中担任独立 Reviewer，严禁将平台与岗位进行任何形式的死板绑定。

### 2. 控制平面与治理平面分离
```
[外部交互 / 用户输入]
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 控制平面 (Control Plane): agent-foundry-orchestrator         │
│  - 状态流转: Created -> Author -> Review -> Fix -> Completed│
│  - 故障自愈: 精确断点恢复、优雅停机、并发锁管理              │
│  - 执行路由: Vertex Gemini / Claude / Codex / Cline         │
└─────────────────────────────────────────────────────────────┘
        │
        │ (仅在任务要求受治理写回时，通过 MCP 协议受控接入)
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 治理平面 (Governance Plane): agent-foundry-vault + vault-mcp │
│  - 知识真源: 架构标准、SOP、正式知识库                       │
│  - 策略仲裁: L2 自动化发布 (auto_publish) / L3 人类门禁     │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔄 任务状态机生命周期 (Lifecycle State Machine)

```
        ┌─────────────┐
        │   CREATED   │
        └──────┬──────┘
               │ 启动调度
               ▼
      ┌─────────────────┐
      │ AUTHOR_RUNNING  │ ◄──────────┐
      └────────┬────────┘            │
               │ 代码产出            │ 自动修复
               ▼                     │ (Exact Resume)
      ┌─────────────────┐            │
      │ REVIEW_RUNNING  │            │
      └────────┬────────┘            │
               │                     │
       ┌───────┴────────┐            │
       ▼                ▼            │
[Review: PASS]   [Review: NEEDS_FIX] ┘
       │
       ▼
 验收命令测试
       │
 ┌─────┴─────┐
 ▼           ▼
[PASS]     [FAIL] ──► 消耗重试预算修复 / 超额转为 FAILED
 │
 ▼
┌─────────────────┐
│    COMPLETED    │
└─────────────────┘
```

---

## 🚀 快速开始 (Quick Start)

### 1. 环境准备
* 运行环境：Node.js >= v20 (推荐 v24)
* 操作系统：Linux / WSL2

### 2. 运行一个任务
编写一个标准的任务定义 JSON 文件（例如 `tasks/demo-task.json`）：
```json
{
  "task_id": "TASK-DEMO-001",
  "goal": "为工程增加一个带有单元测试的字符串反转工具函数",
  "author_executor": "vertex-gemini",
  "reviewer_executor": "claude",
  "author_role": "software-engineer",
  "reviewer_role": "code-reviewer",
  "max_revisions": 3,
  "acceptance_cmd": "node --test tests/demo.test.mjs"
}
```

启动 Orchestrator 进行全自动调度执行：
```bash
node orchestrator.mjs run --task-file tasks/demo-task.json
```

### 3. 运维控制台 CLI (`af-admin`)
系统提供专用的轻量运维管理工具 [`af-admin.mjs`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/af-admin.mjs)：

```bash
# 1. 查看所有或特定执行器的三层状态 (Capability / Availability / Runtime)
node af-admin.mjs executor status
node af-admin.mjs executor status vertex-gemini

# 2. 查看各模型熔断器列表与冷却状态
node af-admin.mjs circuit list

# 3. 执行器账号解封后的受控沙箱隔离探活 (Probe)
node af-admin.mjs executor recovery probe vertex-gemini

# 4. 审核证据后准入解除熔断 (Admit)
node af-admin.mjs executor recovery admit vertex-gemini \
  --evidence <probe_evidence_id> \
  --reason "Upstream billing issue resolved"

# 5. 清理历史已完成任务 (默认 Dry-run 试运行)
node af-admin.mjs tasks prune
node af-admin.mjs tasks prune --confirm

# 6. 审计日志归档轮转
node af-admin.mjs logs rotate --days 7
```

### 4. 故障与宕机恢复 (Crash Recovery)
若宿主断电或进程意外崩溃，重启后执行无副作用的恢复扫描：
```bash
# 纯只读扫描受影响的任务
node orchestrator.mjs recover --scan

# 精确恢复指定任务（自动回收孤儿锁，重构断点会话）
node orchestrator.mjs recover --task-id TASK-DEMO-001
```

---

## 📂 项目目录结构 (Directory Structure)

```
agent-foundry-orchestrator/
├── orchestrator.mjs                   # 主控制平面调度器 CLI & 状态机核心
├── af-admin.mjs                       # 运维管理专用 CLI 工具
├── lib/                               # 核心架构模块
│   ├── acceptance.mjs                 # 确定性验收测试执行引擎
│   ├── adapters.mjs                   # 统一执行器适配器 (Vertex, Claude, Codex, Cline, Antigravity)
│   ├── executor-error-classifier.mjs  # 错误分类器 (Transient / RateLimit / AccountPolicy)
│   ├── executor-ops.mjs               # 运维与受控恢复核心逻辑
│   ├── executor-router.mjs            # 纯函数确定性多执行器路由器
│   ├── executor-runtime-guard.mjs     # 运行时守卫 (断路器状态机、并发槽位限制、日志脱敏)
│   ├── executor-status.mjs            # 执行器能力与可用性状态投影器
│   ├── governance.mjs                 # 知识库治理网桥 (GovernanceBridge)
│   ├── recovery.mjs                   # 宕机断点恢复分析与执行引擎
│   ├── reviews.mjs                    # 独立 Reviewer 结果解析与绑定
│   ├── scheduler.mjs                  # 任务状态机驱动核心
│   ├── store.mjs                      # POSIX 原子文件持久化存储
│   ├── tasklock.mjs                   # 基于文件系统的排他互斥锁与死锁回收
│   └── vault-client.mjs               # MCP Vault 治理客户端
├── tasks/                             # 任务持久化真源目录 (*.json)
├── runtime/                           # 运行时状态、安全策略与清洗后的审计日志
├── locks/                             # 进程互斥排他锁目录
└── tests/                             # 自动化测试套件 (91 个用例全部通过)
```

---

## 🧪 自动化测试验证 (Testing & Verification)

运行全量测试套件：
```bash
node --test
```

**测试矩阵覆盖 (91 / 91 PASS)**：
* **单测与 E2E 闭环**：多工作区并行隔离、Review 修复循环、断点 Exact Resume；
* **并发与锁竞争**：双实例锁互斥、Dead PID 锁抢占、防并发爆冲；
* **错误注入与熔断**：403 Fail-Closed、限流退避、探活与准入工作流；
* **进程优雅关闭**：SIGTERM 信号回收、活跃子进程终止、零孤儿句柄；
* **架构不变性**：单注册表真源检验、单调度器检验、防凭证落盘检测、`ROLE != PLATFORM` 检验。

---

## 📚 详细规范文档索引 (Documentation)

* 🏛️ [架构终态设计蓝图 (`FINAL_ARCHITECTURE.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/FINAL_ARCHITECTURE.md)
* 🛡️ [执行器安全与熔断模型 (`EXECUTOR_SAFETY_MODEL.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/EXECUTOR_SAFETY_MODEL.md)
* 📖 [生产运维标准操作手册 (`OPERATOR_RUNBOOK.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/OPERATOR_RUNBOOK.md)
* 🚨 [生产灾难恢复操作手册 (`DISASTER_RECOVERY.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/DISASTER_RECOVERY.md)
* 📋 [生产冻结发布清单 (`RELEASE_MANIFEST.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/RELEASE_MANIFEST.md)
* 🔒 [基线变更控制协议 (`CHANGE_CONTROL.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/CHANGE_CONTROL.md)
* 🔍 [持久化与安全审计报告 (`PERSISTENCE_CHECK.md` / `SECURITY_AUDIT.md`)](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/SECURITY_AUDIT.md)
