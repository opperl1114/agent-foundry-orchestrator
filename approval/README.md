# Agent Foundry Human Intent Alignment Layer (PHASE 9-D)

## 1. 架构定位 (Architecture Placement)

Human Intent Alignment Gate 位于 Planner 与 Scheduler 之间，在 AI 规划与实际执行之间建立意图确认边界：

```
User Conversation
        |
        v
External Agent (Antigravity / Claude / Codex)
        |
        | MCP Tool Call: foundry_submit_task
        v
agent-foundry-gateway
        |
        | Task Capsule
        v
Planner Layer (PHASE 9-C)
        |
        | Task Plan
        v
Human Intent Alignment Gate (PHASE 9-D)
        |
   [Auto-Allow / Human Approved]
        |
        v
Scheduler (lib/scheduler.mjs)
        |
        v
Executor Router (lib/executor-router.mjs)
        |
        v
Executors (Claude / Codex / Antigravity)
```

> **重要约束**：Human Intent Alignment Gate **不替代 Scheduler**。
> Scheduler 继续全权负责任务生命周期、状态机、控制面锁与故障恢复。
> Alignment Gate 只负责回答一个核心问题：**AI 是否被允许进入执行阶段？**

---

## 2. 核心判断模型 (Intent Alignment Policy)

拒绝简单的 HIGH / MEDIUM / LOW 分级，依据 **Intent Alignment Policy** 6 大确定性规则进行判定：

| 规则 | 触发条件 | 判定结果 | 说明 |
| :--- | :--- | :--- | :--- |
| **1. 方向确认** | AI 规划提出重构目录、合并分类、删除重复等方向变更 | `WAITING_HUMAN` | 确认 AI 规划方向是否契合人类意图 |
| **2. 知识治理变化** | 涉及 `SCHEMA.md`、`index.md`、metadata 规则或知识库目录结构 | `WAITING_HUMAN` | 保护核心知识治理体系 |
| **3. 系统配置变化** | 涉及 `AGENTS.md`、MCP、Executor、Scheduler 或运行规则 | `WAITING_HUMAN` | 严防未授权的系统规则变动 |
| **4. 删除操作** | 批量/递归删除、不可逆删除、删除知识资产或核心代码 | `WAITING_HUMAN` | 清理临时文件/缓存（`routine_cleanup`）则自动放行 |
| **5. 发布操作** | 公开发布、网站上线、对外 Release | `WAITING_HUMAN` | 内部草稿生成无需确认 |
| **6. 普通生成任务** | 文档生成、代码分析、方案设计、信息整理、缺陷修复 | `AUTO_ALLOWED` | 零阻碍自动流转至 Scheduler 执行 |

---

## 3. 状态设计 (Lifecycle States)

复用 Orchestrator 既有状态，严禁创建第二状态机：

```
READY
  ↓
PLANNING (Planner Layer)
  ↓
WAITING_HUMAN (Intent Gate: PENDING_HUMAN)
  ↓
APPROVED (User: foundry_approve_intent)
  ↓
AUTHOR_RUNNING (Scheduler Execution)
  ↓
...
COMPLETED
```

若人类拒绝方案：
```
WAITING_HUMAN
  ↓
CANCELLED (User: foundry_reject_intent)
```

---

## 4. MCP Tools 接口

### `foundry_approve_intent`
人类确认并批准任务执行方案。

* **参数**：
  ```json
  {
    "task_id": "TASK-20260907-XXXX",
    "reason": "确认执行该方案"
  }
  ```
* **返回**：
  ```json
  {
    "task_id": "TASK-20260907-XXXX",
    "status": "APPROVED"
  }
  ```

### `foundry_reject_intent`
人类拒绝任务执行方案。

* **参数**：
  ```json
  {
    "task_id": "TASK-20260907-XXXX",
    "reason": "方向不符合要求"
  }
  ```
* **返回**：
  ```json
  {
    "task_id": "TASK-20260907-XXXX",
    "status": "CANCELLED"
  }
  ```

---

## 5. Approval 记录与数据持久化

* **零数据库原则**：所有对齐记录直接写入现有 Task Capsule 文件（`tasks/<task_id>.json`）。
* **记录格式**：
  ```json
  {
    "task_id": "TASK-20260907-XXXX",
    "state": "WAITING_HUMAN",
    "intent_alignment": {
      "required": true,
      "reason": "knowledge_governance_change",
      "status": "PENDING_HUMAN",
      "evaluated_at": "2026-09-07T11:18:00.000Z"
    }
  }
  ```

---

## 6. 安全边界与不可降级红线

* ✅ **允许**：判断是否需要确认、写入 `intent_alignment` 记录、设置 `WAITING_HUMAN` / `APPROVED` / `CANCELLED`。
* ❌ **禁止选择 Executor**（遵循 `ROLE != PLATFORM`，Router 拥有唯一选择权）。
* ❌ **禁止直接调用 Executor / Adapter**（严禁在 Intent Gate 中执行代码）。
* ❌ **禁止篡改 Vault 治理决策**（`vault-mcp` 拥有唯一真实凭据）。
* ❌ **禁止绕过 Scheduler**（批准后交由 Scheduler 进行队列与并发执行）。
