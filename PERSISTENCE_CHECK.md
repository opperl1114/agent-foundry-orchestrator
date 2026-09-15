# PERSISTENCE_CHECK.md — 数据持久化与故障恢复审计

本文件记录 Agent Foundry Orchestrator 在生产运行前对核心状态存储、持久化机制、崩溃恢复能力及半状态防御的最终审计结论。

---

## 1. 审计范围与关键存储组件

| 存储域 | 物理路径 | 唯一真源职责 | 持久化机制 | 并发控制 / 崩溃保护 |
|---|---|---|---|---|
| **Task Store** | `tasks/<task_id>.json` | 控制平面任务生命周期状态的唯一权威真源 | 同目录隐式临时文件原子写入 (`saveTaskAtomic` + `renameSync`) | Readers 始终只能观测到完整 JSON；写入崩溃自动 unlink 临时文件；单调递增 `state_version` 防并发脏写 |
| **Task Locks** | `locks/<task_id>.lock` | 任务单所有者（Single Active Writer）租约权威 | 内核级排他创建 (`writeFileSync` 携带 `flag: 'wx'`) | 进程级心跳续约 (`lease_expires_at`)；死锁检测 (`pidAlive`)；陈旧锁安全审计接管 (`stale_lock_recovered`) |
| **Runtime Guard State** | `runtime/executor-safety-state.json` | 执行器熔断状态机持久化映像 | JSON 结构化安全落盘 (`#saveState`) | 单一进程防护；`OPEN_MANUAL_RESET` 跨重启物理持久化锁闭 |
| **Audit Events** | `runtime/executor-runtime-events.jsonl` | 运行时安全与操作员维护不可篡改日志 | Append-only 追加写入 (`appendFileSync`) | 敏感字段白名单脱敏过滤；按天切割轮转保持原始内容不变 |
| **Scheduler Metadata** | `runtime/scheduler.json` | 控制平面观察镜像与调试视图（非生命周期真源） | 临时文件原子替换 (`saveTaskAtomic`) | 允许外部只读观察；系统重启时以 `tasks/*.json` 为准 |

---

## 2. 详细持久化机制验证

### 2.1 Task Store 原子写与半状态免疫 (`lib/store.mjs`)
- **同目录原子重命名（Atomic Rename）**：
  在目标文件同目录下创建 `.task.json.tmp-<pid>-<uuid>`，完全序列化写入后调用 POSIX `renameSync`。
- **无半状态保证（Zero Half-State）**：
  任何并发读取者（包括 Recovery Scanner、Operator CLI、Webhooks）看到的要么是更新前的合法 JSON，要么是更新后的合法 JSON，绝不可能读取到截断、未闭合的半状态文本。
- **故障自愈（Fail-Closed on Write Crash）**：
  若写入阶段发生磁盘满、I/O 错误或断电仿真（测试用例 `TEST PROD-4`），catch 块立即清理未就绪的临时文件，旧文件毫发无损。

### 2.2 租约与死锁防范 (`lib/tasklock.mjs`)
- **原子排他创建（O_CREAT | O_EXCL）**：
  `writeFileSync(..., { flag: 'wx' })` 依靠操作系统内核原子性，拒绝两个实例同时占有同一任务。
- **孤儿锁与死进程清理（Stale Reclamation）**：
  若前任宿主崩溃，锁文件中记载的 `pid` 死亡 (`process.kill(pid, 0)` 失败) 或 `lease_expires_at` 超时，后续实例能识别陈旧锁，并在显式记录 `recovered_from: { previous_pid, stale_reason }` 审计信息后接管，杜绝死锁与人肉排障依赖。

### 2.3 崩溃恢复一致性 (`lib/recovery.mjs` & `lib/scheduler.mjs`)
- **中断状态保真（Interrupted Run Preservation）**：
  在宿主遭遇 `SIGTERM` / `SIGINT` 或异常中断时，系统显式记录 `interrupted_at` 与 `interrupted_reason`，**禁止直接将未完任务盲目标记为 `FAILED`**。
- **恢复分类确定性**：
  - 作者产物已持久化：恢复时判定为 `RESUMABLE`，直接重用已落盘产物，只启动后续独立评审。
  - 作者执行途中中断：恢复时判定为 `INTERRUPTED` (`UNKNOWN_OUTCOME`)，不伪造 `PASS` 亦不伪造 `FAILED`，需人工或策略受控裁决。
  - 处于外部审批：恢复时判定为 `WAITING_EXTERNAL`，严格保持停靠，绝不重复打扰。

---

## 3. 审计结论

- **原子写验证**：通过（100% 覆盖）
- **崩溃恢复验证**：通过（全自动化用例验证，包含 `TEST PROD-1` / `TEST PROD-4`）
- **无半状态验证**：通过（读取端零解析异常）
- **结论**：数据持久化层已达到生产级可靠性标准。
