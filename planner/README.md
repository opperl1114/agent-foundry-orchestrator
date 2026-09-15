# Agent Foundry Planner Layer (PHASE 9-C)

## 概述

**Planner Layer** 是 Agent Foundry 位于 MCP Gateway 与 Scheduler 之间的任务理解与规划层。

它负责：
1. **用户目标理解**：解析来自自然语言对话的 Task Capsule。
2. **任务拆解**：将复杂任务拆分为有序执行阶段（步骤）。
3. **生成执行计划**：产出遵循统一 Schema 的 Task Plan。

它绝不负责：
- ❌ 执行任务（不运行代码、不调用子进程）
- ❌ 选择 Executor（严守 `ROLE != PLATFORM`，只派发角色如 `author`/`reviewer`，绝不分配 `claude`/`agy`/`codex`）
- ❌ 绕过 Scheduler（计划必须作为 Task Capsule 的 `planner_result` 移交给 Scheduler）
- ❌ 修改 Governance（知识治理唯一真源严格保留在 `vault-mcp`）

---

## 架构拓扑

```
User Conversation
        |
        v
MCP Gateway (agent-foundry-gateway)
        |
        | Task Capsule { task_id, goal, context }
        v
Planner Layer (planner/planner.mjs)
        |
        | Task Plan { task_id, plan: [ { step, goal, role } ] }
        v
Enriched Capsule { task_id, planner_result: { plan }, state: "READY" }
        |
        v
Scheduler (lib/scheduler.mjs)
        |
        v
Executor Router (lib/executor-router.mjs)
        |
        v
Executor Adapters (Vertex / Claude / Codex / AGY)
```

---

## 计划数据模型 (Task Plan Schema)

```json
{
  "task_id": "TASK-20260907-001",
  "planner_provider": "antigravity",
  "summary": "Plan for 开发商城搜索功能",
  "created_at": "2026-09-07T11:00:00.000Z",
  "plan": [
    {
      "step": 1,
      "goal": "需求分析与方案设计",
      "role": "author"
    },
    {
      "step": 2,
      "goal": "核心搜索逻辑实现与测试",
      "role": "author"
    },
    {
      "step": 3,
      "goal": "代码规范与完整性独立审查",
      "role": "reviewer"
    }
  ]
}
```

---

## 架构约束与安全边界

1. **ROLE != PLATFORM 强校验**：
   `validateTaskPlan()` 与 JSON Schema 共同保证，Plan 顶层及每个步骤中绝对禁止出现 `executor`、`platform`、`author_executor` 等字段。
2. **固定 Planner Provider v1**：
   当前第一版本固定使用 `antigravity` 作为 Planning 能力提供源。该绑定仅仅是能力来源，绝不改变任务本身的动态执行器路由。
3. **无缝注入 Scheduler**：
   生成的计划作为 Task Capsule 的 `planner_result` 字段持久化至 `tasks/<id>.json`，由调度器接管生命周期。
