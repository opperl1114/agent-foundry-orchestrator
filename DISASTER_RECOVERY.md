# Agent Foundry Orchestrator - Disaster Recovery Runbook

> **适用范围**: Agent Foundry Orchestrator 生产灾难恢复操作（DR Runbook）。  
> **基线版本**: Production Freeze v1。  
> **核心原则**: 优先保障安全隔离与数据完整性，宁可停机等待人工准入，绝不静默重试引发连环故障。

---

## 灾难场景 1: 执行器账号被禁用 / 封禁 (Executor Account Disabled)

### 故障特征
- 调度器抛出 `ACCOUNT_POLICY` 或 HTTP 403 Forbidden、TOS Violation。
- 该执行器的断路器自动进入 `OPEN_MANUAL_RESET` 闭锁状态。
- 所有尝试分发到该执行器的任务立即被阻止（Fail-Closed），路由层禁止向其 Fallback。

### 应急处置流程

```
+-----------------------------------+
| 1. 查询执行器状态与熔断器信息     |
|    node af-admin.mjs executor status <name>
|    node af-admin.mjs circuit list |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
| 2. 外部供应商控制台解决账号问题   |
|    (续约/补缴/解封/更新密钥)      |
+-----------------------------------+
                  |
                  v
+-----------------------------------+
| 3. 发起受控沙箱隔离探活           |
|    node af-admin.mjs executor recovery probe <name>
+-----------------------------------+
                  |
                  | (probe 生成 evidence_id, 状态转为 HALF_OPEN)
                  v
+-----------------------------------+
| 4. 操作员审核凭证并显式准入       |
|    node af-admin.mjs executor recovery admit <name> \
|      --evidence <id> --reason "..."
+-----------------------------------+
```

#### 步骤 1: 检查当前状态
```bash
# 查看执行器综合状态
node af-admin.mjs executor status antigravity

# 查看熔断器列表
node af-admin.mjs circuit list
```

#### 步骤 2: 修复上游账号
在云厂商控制台（如 Google Cloud Console、Anthropic Console）排查账户状态、账单状态及 API 权限，完成解封或配额提升。

#### 步骤 3: 触发隔离沙箱探活 (Probe)
```bash
node af-admin.mjs executor recovery probe <executor>
```
*验证*: 命令输出 `outcome: SUCCESS`，产生 `probe_evidence_id`，熔断器进入 `HALF_OPEN`。

#### 步骤 4: 审核并执行准入 (Admit)
```bash
node af-admin.mjs executor recovery admit <executor> \
  --evidence <probe_evidence_id> \
  --reason "Account unbanned and verified via probe" \
  --admitted-by "operator-oncall"
```
*验证*: 熔断器状态重置为 `CLOSED`，调度器重新允许分配流量。

---

## 灾难场景 2: 调度器宿主进程异常崩溃 (Scheduler Crash)

### 故障特征
- Orchestrator 进程因机器断电、内核 OOM Killer、或未捕获硬件异常突然终止。
- 任务文件仍停留在 `AUTHOR_RUNNING` 或 `REVIEW_RUNNING` 中间态。
- `locks/` 目录下残留旧的锁文件，锁内记录的 PID 已不存在。

### 应急处置流程

```
+-------------------------------------------------+
| 1. 无副作用扫描系统中所有待恢复任务             |
|    node orchestrator.mjs recover --scan         |
+-------------------------------------------------+
                        |
                        v
+-------------------------------------------------+
| 2. 检查特定任务详情与锁状态                     |
|    node orchestrator.mjs inspect --task-id <id> |
+-------------------------------------------------+
                        |
                        v
+-------------------------------------------------+
| 3. 显式执行指定任务恢复                         |
|    node orchestrator.mjs recover --task-id <id> |
+-------------------------------------------------+
```

#### 步骤 1: 扫描受影响任务
```bash
node orchestrator.mjs recover --scan
```
*系统保证*: 该命令是纯只读分析，仅输出待恢复任务清单及推荐恢复动作（如 `RECOVER_AUTHOR_IN_PROGRESS`），绝不自动擅自重跑。

#### 步骤 2: 审查任务上下文
```bash
node orchestrator.mjs inspect --task-id TASK-001
```
*确认*: 锁对应的 PID 是否确为 Dead PID，任务已持久化的 runs 记录是否完整。

#### 步骤 3: 触发安全精准恢复
```bash
node orchestrator.mjs recover --task-id TASK-001
```
*恢复保证*:
- 自动回收 Dead PID 的过期锁，生成锁抢占审计日志。
- 若 Author 阶段持久化完整但尚未 Review，只启动 Reviewer。
- 若 Reviewer 要求 `NEEDS_FIX`，严格精确恢复（Exact Resume）上一个 Author 的 `session_ref`，不从头重算。
- 被中断的 Author 记录被标为 `UNKNOWN_OUTCOME`，不伪造成功或失败。

---

## 灾难场景 3: 运行时数据损坏 (Runtime State Corruption)

### 故障特征
- 磁盘由于掉电导致某个 `tasks/<id>.json` 或 `runtime/executor-safety-state.json` 发生截断、内容全为零或非合法 JSON。
- 调度器启动或加载时报错，系统触发 Fail-Closed，拒绝加载损坏文件。

### 应急处置流程

#### 步骤 1: 隔离损坏数据文件
严禁直接覆写或手动修改正在被访问的文件。首先隔离坏文件：
```bash
mkdir -p tasks/corrupted_quarantine
mv tasks/<corrupted_task_id>.json tasks/corrupted_quarantine/
```

#### 步骤 2: 从最近的原子备份中恢复
```bash
# 检查备份完整性
tar -tzf /var/backups/agent-foundry/af-backup-<latest>.tar.gz | grep tasks/<corrupted_task_id>.json

# 精确恢复单个任务文件
tar -xzf /var/backups/agent-foundry/af-backup-<latest>.tar.gz tasks/<corrupted_task_id>.json
```

#### 步骤 3: 恢复运行时断路器状态（如 safety-state 损坏）
如果 `runtime/executor-safety-state.json` 损坏：
```bash
# 从备份恢复
tar -xzf /var/backups/agent-foundry/af-backup-<latest>.tar.gz runtime/executor-safety-state.json

# 或将其移走，系统将在下一次启动时初始化为默认安全状态 (All CLOSED)
mv runtime/executor-safety-state.json runtime/corrupted_safety_state.json.bak
```

#### 步骤 4: 校验与重载
```bash
node orchestrator.mjs inspect --task-id <task_id>
node af-admin.mjs circuit list
```

---

## 灾难场景 4: 宿主整机迁移 (Host Migration)

### 故障特征
- 需要将 Agent Foundry Orchestrator 从原宿主机（Host A）迁移到新宿主机（Host B）。
- 要求：零任务丢失、零半状态泄露、零死锁遗留。

### 应急处置流程

#### 步骤 1: 原宿主机优雅停机
向正在运行的调度器主进程发送终止信号：
```bash
# 获取 orchestrator 进程 PID
PID=$(pgrep -f "node orchestrator.mjs run")
if [ -n "$PID" ]; then
  kill -TERM "$PID"
  # 等待进程退出，确保子进程已被完全终止
  while kill -0 "$PID" 2>/dev/null; do sleep 1; done
fi
```

#### 步骤 2: 生成迁移冷备份
必须排除 `locks/` 运行时互斥锁与 `runtime/runs/` 临时句柄文件，防止将旧主机的 PID 状态带到新主机：
```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
tar -czf "af-migration-$TIMESTAMP.tar.gz" \
  --exclude="locks/*" \
  --exclude="runtime/runs/*" \
  --exclude="*.log" \
  tasks/ \
  runtime/
```

#### 步骤 3: 传输与在新主机解包
```bash
# 复制到新宿主机
scp "af-migration-$TIMESTAMP.tar.gz" user@host-b:/opt/agent-foundry/

# 在新宿主机解包
cd /opt/agent-foundry-orchestrator
tar -xzf "af-migration-$TIMESTAMP.tar.gz" -C ./

# 确保 locks/ 目录存在且为空
mkdir -p locks runtime/runs
rm -rf locks/* runtime/runs/*
```

#### 步骤 4: 新主机环境健康检查
```bash
# 1. 验证 Node.js 运行环境与依赖
node --version
node --test

# 2. 检查各 Executor 能力与可用性
node af-admin.mjs executor status

# 3. 扫描未决任务并恢复
node orchestrator.mjs recover --scan
```
新主机确认无异常后，可继续提交新任务或恢复中断任务。
