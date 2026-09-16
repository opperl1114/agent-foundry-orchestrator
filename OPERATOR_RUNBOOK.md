# Agent Foundry Orchestrator - Operator Runbook

> **适用范围**: Agent Foundry Orchestrator 生产环境运维与故障恢复操作手册。  
> **基线规范**: PHASE 8-A Production Freeze 基线。  
> **安全红线**: 严格遵循 `ROLE != PLATFORM`，绝不绕过断路器（Circuit Breaker）安全保护，禁止私自篡改原子状态存储。

---

## 1. 启动与执行系统 (Start the System)

Orchestrator 是以单一任务文件（Task File）为驱动的控制平面调度器。

### 1.1 执行任务

通过 CLI 提交任务定义并执行完整的生命周期（author -> review -> acceptance -> complete）：

```bash
# 标准启动
node orchestrator.mjs run --task-file <path/to/task.json>
```

#### 正常执行行为
- 加载 `task.json`，验证静态字段与接受命令白名单。
- 申请文件级互斥排他锁（`locks/<task_id>.lock`）。
- 调度 primary 或 fallback 执行器运行 author。
- 由独立 reviewer 执行结构化代码审查。
- 执行严格限定的 acceptance 验证命令。
- 完成后进入 `COMPLETED` 终态并释放锁。

### 1.2 终止与优雅关闭 (Graceful Shutdown)

Orchestrator 支持通过 `SIGINT` (Ctrl+C) 或 `SIGTERM` 触发优雅停机：

```bash
# 向 Orchestrator 进程发送终止信号
kill -TERM <PID>
```
- Orchestrator 捕获信号后，主动向所有活跃的子进程发送信号并清理句柄，**包括正在执行的验收子进程**。
- 未完成的任务保留在当前状态，等待后续显式恢复。

#### 取消任务与验收子进程的边界（务必分清两种信号）

`orchestrator.mjs cancel --task-id <id>` 只作用于**执行器**进程（它按运行句柄 + `/proc/<pid>/cmdline` 校验身份后发信号）。它**不覆盖进行中的验收命令**，这是刻意的：把验收子进程杀掉，在属主进程看来就是"验收命令失败"，可能把任务推进修复循环，而不是取消它。所以：

```bash
# 正确：用 SIGTERM 停掉属主进程，验收子进程会在进程内被回收
kill -TERM <orchestrator pid>

# 不要用 SIGKILL 停属主：SIGTERM 处理器不会运行，
# 验收子进程会被收养，且它依赖的进程内超时（acceptance_timeout_ms）也随之消失
```

若确实发生了 `SIGKILL`（或属主进程崩溃），遗留的验收子进程可以通过其**持久句柄**找到并回收：

```bash
af-admin acceptance list            # 列出验收子进程句柄（含是否孤儿）
af-admin acceptance reap            # 干跑：只报告将处理哪些
af-admin acceptance reap --confirm  # 只回收"属主已死且 cmdline 仍与记录一致"的进程
```

`reap` 的两条硬性前提：**属主进程已死**（不是"父进程是 1"——容器/supervisor 下孤儿会被 subreaper 收养，永远不会成为 PID 1），且 `/proc/<pid>/cmdline` 仍与句柄记录的命令一致（防 PID 复用）。任一不满足即拒杀，属主健在的进程始终由它自己的 `acceptance_timeout_ms` 约束。

---

## 2. 查看执行器状态 (Inspect Executor Status)

运维人员可以通过 `af-admin` 工具查看各执行器的三维状态矩阵（Capability / Availability / Runtime Safety）及熔断器状态。

### 2.1 查看所有或指定执行器综合状态

```bash
# 查看所有执行器状态
node af-admin.mjs executor status

# 查看特定执行器状态（支持 alias，例如 antigravity 或 agy）
node af-admin.mjs executor status antigravity
node af-admin.mjs executor status claude
node af-admin.mjs executor status vertex-gemini
```

**输出示例**:
```text
executor:
antigravity

capability:
READY

availability:
ACCOUNT_DISABLED

runtime:
OPEN_MANUAL_RESET

reason:
TOS_VIOLATION

circuit:
OPEN

last_failure:
TOS_VIOLATION

reset_required:
true
```

> **安全原则**: `af-admin` 绝不输出 token、credential、私钥或 prompt/response 内容。

### 2.2 查看熔断器列表 (Circuit List)

```bash
node af-admin.mjs circuit list
```

**输出字段说明**:
- `CIRCUIT STATE`: `CLOSED`（正常）、`OPEN_COOLDOWN`（自动冷却中）、`OPEN_MANUAL_RESET`（人工锁定）、`PROBING`（探测中）、`HALF_OPEN`（试运行）。
- `LAST FAILURE`: 触发熔断的错误分类（如 `ACCOUNT_POLICY`, `RATE_LIMIT`）。
- `COOLDOWN`: 自动冷却截止时间（若为 MANUAL 则不自动冷却）。
- `RESET BY`: 上一次人工重置或准入操作者。

---

## 3. 处理 `OPEN_MANUAL_RESET` 熔断状态

当执行器遭遇致命策略违规（如 403 Forbidden、TOS Violation、Suspended Account）时，断路器自动闭锁为 `OPEN_MANUAL_RESET`。禁止任何自动探活与重试。必须由操作员执行受控准入流程。

```
+---------------------+      af-admin probe      +---------+
|  OPEN_MANUAL_RESET  | -----------------------> | PROBING |
+---------------------+                          +---------+
                                                      | (probe ok)
                                                      v
     +--------+        af-admin admit            +-----------+
     | CLOSED | <------------------------------- | HALF_OPEN |
     +--------+     (--evidence & --reason)      +-----------+
```

### 步骤 1: 外部环境核验
在执行命令前，操作员必须确认外部账号或网络故障已在供应商控制台解决（如完成账单补缴、申诉解封）。

### 步骤 2: 发起隔离探活 (Execute Probe)

```bash
node af-admin.mjs executor recovery probe <executor>
```

- 该命令在隔离的沙箱临时任务中向适配器发起一次受控的轻量调用。
- 探测过程中断路器临时进入 `PROBING` 状态。
- 若探活成功，生成唯一的 `probe_evidence_id`，并将状态转为 `HALF_OPEN`。

**探活成功示例**:
```text
Recovery probe result:
executor: vertex-gemini
outcome: SUCCESS
circuit_state: HALF_OPEN
probe_evidence_id: probe-vertex-gemini-1725667200000-abcd1234
```

### 步骤 3: 审查证据并正式准入 (Admit)

操作员审查返回的 `probe_evidence_id` 后，提交带有明确原因的操作命令：

```bash
node af-admin.mjs executor recovery admit <executor> \
  --evidence <probe_evidence_id> \
  --reason "Account restored and verified via sandbox probe" \
  --admitted-by "operator-alice"
```

准入成功后，断路器恢复为 `CLOSED`，调度器重新允许向该执行器分发生产流量。

### 紧急情况: 强制管理重置 (Emergency Circuit Reset)

若探测机制由于隔离环境受限无法运行，但操作员拥有确切的外部凭证修复证据，可执行受审计的人工强制重置：

```bash
node af-admin.mjs circuit reset <executor> \
  --reason "Emergency override: upstream subscription renewed" \
  --reset-by "lead-sre"
```

---

## 4. 恢复失败或中断任务 (Task Recovery)

当 Orchestrator 进程异常崩溃或宿主重启后，系统中可能残留未完成的任务。系统绝不自动静默重跑，必须由运维人员介入。

### 4.1 扫描待恢复任务 (Scan-Only)

首先执行无副作用的恢复扫描：

```bash
node orchestrator.mjs recover --scan
```

扫描器会分析所有非终态任务，并输出恢复分类建议（例如 `RECOVER_AUTHOR_IN_PROGRESS`, `RECOVER_REVIEW_IN_PROGRESS`, `TERMINAL` 等）。

### 4.2 审查特定任务详细信息

```bash
node orchestrator.mjs inspect --task-id <task_id>
```

检查：
- 当前状态与修订版本 (`state_version`, `revision`)。
- 锁状态（是否为 stale 锁）。
- 历史运行记录 (`runs`)。

### 4.3 执行单任务恢复

确认任务安全且上下文就绪后，显式指定 Task ID 进行恢复：

```bash
node orchestrator.mjs recover --task-id <task_id>
```

恢复引擎将：
1. 抢占或清理过期的孤儿锁。
2. 基于已持久化的最新证据重构执行上下文。
3. 从断点处安全继续调度，直至任务终态。

---

## 5. 清理历史任务与日志归档 (Prune & Log Rotation)

为防止磁盘空间耗尽与文件检索性能下降，提供安全无害的维护命令。

### 5.1 清理历史任务 (Task Pruning)

系统仅清理处于终态（`COMPLETED`, `FAILED`, `CANCELLED`）且未被加锁的任务。正在运行中或状态损坏的文件受到严格保护。

#### 第一步：试运行检查 (Dry-run)
```bash
node af-admin.mjs tasks prune
```
输出将要被删除的候选任务列表，不执行实际删除。

#### 第二步：确认清理 (Execute Prune)
```bash
node af-admin.mjs tasks prune --confirm
```

### 5.2 审计日志轮转 (Log Rotation)

对 `runtime/executor-runtime-events.jsonl` 进行截断归档：

```bash
# 归档 7 天前的事件到 runtime/archive/
node af-admin.mjs logs rotate --days 7

# 指定自定义保留天数
node af-admin.mjs logs rotate --days 14
```

- 归档文件保存在 `runtime/archive/executor-runtime-events-<date>-<uuid>.jsonl`。
- 截断写入采用原子写，不丢失新追加的实时事件。

---

## 6. Runtime 目录备份与灾难恢复 (Backup & Disaster Recovery)

### 6.1 备份策略

Orchestrator 的持久化状态集中在 `tasks/` 与 `runtime/` 目录中。

**建议备份内容**:
- `tasks/*.json` (任务真相文件)
- `runtime/executor-safety-state.json` (断路器状态)
- `runtime/executor-runtime-events.jsonl` (运行事件审计)

**必须排除的内容**:
- `locks/*` (运行时排他锁文件，包含临时 PID 与心跳，不能带入备份)
- `runtime/runs/*` (运行句柄临时描述符)

### 6.2 推荐备份命令

使用 `tar` 创建备份压缩包：

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/agent-foundry"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

tar -czf "$BACKUP_DIR/af-backup-$TIMESTAMP.tar.gz" \
  --exclude="locks/*" \
  --exclude="runtime/runs/*" \
  tasks/ \
  runtime/
```

### 6.3 灾难恢复步骤

1. **停止 Orchestrator**: 确保无活跃调度实例在运行。
2. **清理锁目录**: 恢复前必须清空 `locks/` 目录（`rm -rf locks/*`）。
3. **解压数据文件**:
   ```bash
   tar -xzf /path/to/af-backup-<timestamp>.tar.gz -C ./
   ```
4. **验证执行器状态**:
   ```bash
   node af-admin.mjs executor status
   node af-admin.mjs circuit list
   ```
5. **恢复未决任务**:
   ```bash
   node orchestrator.mjs recover --scan
   ```
