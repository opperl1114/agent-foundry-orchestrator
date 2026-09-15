# Agent Foundry Orchestrator - Change Control Protocol

> **基线版本**: Production Freeze v1  
> **适用范围**: `agent-foundry-orchestrator` 所有后续代码修改、依赖更新与配置变更。  
> **核心原则**: 严禁架构膨胀，保持控制平面轻量、确定性与单一真相源。

---

## 1. 变更分类分级

### 1.1 允许的标准变更 (Allowed Standard Changes)

以下类型的变更属于允许范围，但仍需经过单元测试验证与回归测试：

1. **缺陷修复 (Bug Fix)**:
   - 针对已有逻辑中的边界条件遗漏、异常捕获不完备、路径拼接解析错误等进行的精确修复。
   - 约束：修复代码不得改变调度状态机流转契约，不得改变各层对外暴露的 API 契约。
2. **安全补丁 (Security Patch)**:
   - 针对潜在的信息泄露、输入清洗漏洞、PID 伪造或命令注入风险进行的加固。
   - 约束：加固动作必须遵循 Fail-Closed 原则，不得通过放宽权限或跳过验证来实现。
3. **依赖更新 (Dependency Update)**:
   - Node.js 运行时安全更新或底层非破坏性依赖的小版本修补（SemVer patch/minor）。
   - 约束：必须完成全量测试套件（`node --test`）100% 通过验证。

---

### 1.2 未经架构评审严禁引入的重大变更 (Forbidden Without Review)

以下架构扩展在未获得架构师明确评审与批准前，**严格禁止实现或引入**：

| 严禁事项 | 违规风险分析 | 架构替代原则 |
| :--- | :--- | :--- |
| **新增第二调度器 (New Scheduler)** | 引入并发竞态、状态分裂、任务生命周期无法收敛。 | 单一任务状态机驱动（`orchestrator.mjs` + `lib/scheduler.mjs`）是唯一调度核心。 |
| **新增第二治理层 (New Governance Plane)** | 削弱或绕过全局知识库 `vault-mcp` 治理权威，导致未授权知识写入。 | 任何正式知识发布必须经由 `GovernanceBridge` 委托给 `agent-foundry-vault`。 |
| **新增第二注册表 (New Registry)** | 能力真源不一致，破坏全局执行器描述符规范。 | 唯一真源为 `agent-foundry-global/executors/*.json`，禁止本地自建冗余 registry。 |
| **引入外部数据库 (New Database)** | 引入外部网络依赖、增加数据库运维负担、破坏文件级原子写入简单性。 | 坚持基于文件系统原子重命名 (`saveTaskAtomic`) 与文件锁 (`tasklock.mjs`) 的无依赖架构。 |
| **引入 Web 控制平面 (Web Control Plane)** | 暴露监听端口与攻击面，引入 Web 权限认证复杂度。 | 运维控制全部通过本地 CLI (`orchestrator.mjs`, `af-admin.mjs`) 与标准 POSIX 信号完成。 |
| **硬编码角色与平台绑定 (Role-Platform Binding)** | 违反 `ROLE != PLATFORM` 全局治理红线。 | 适配器必须仅实现执行原语，角色动态注入自 Task Capsule。 |

---

## 2. 变更提交流程 (Change Request Lifecycle)

所有计划合入生产基线的改动必须遵守以下四步门禁：

```
+----------------+      1. Impact Check      +--------------------+
| Change Request | ------------------------> | Invariant Check    |
+----------------+                           +--------------------+
                                                        |
                                                        | 2. Automated Validation
                                                        v
+----------------+     4. Merge / Deploy     +--------------------+
|  Sign-off &    | <------------------------ | Independent Review |
| Freeze Update  |    3. Verification Pass   | (author != review) |
+----------------+                           +--------------------+
```

### 步骤 1: 架构影响评估 (Impact & Invariant Check)
- 确认变更属于 Allowed 类别。
- 确认变更未修改 `scheduler.mjs` 状态流转、`executor-runtime-guard.mjs` 状态机、`governance.mjs` 判定规则。

### 步骤 2: 自动化验证 (Automated Validation)
- 运行全量测试套件：
  ```bash
  node --test
  ```
- 运行架构不变性测试套件：
  ```bash
  node --test tests/architecture-invariant.test.mjs
  ```
- 必须实现 100% 绿灯通过，无跳过或失败用例。

### 步骤 3: 独立审查 (Independent Review)
- 遵循 `author_instance_id != reviewer_instance_id` 原则。
- 必须由非作者的独立评审人审查变更 diff，重点核查是否包含隐藏的凭据持久化、自动探活定时器或静默重试逻辑。

### 步骤 4: 签发与基线更新 (Sign-off & Release Manifest Update)
- 变更合并后，必须更新 [`RELEASE_MANIFEST.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/RELEASE_MANIFEST.md) 中的版本记录、提交哈希与测试时间戳。

---

## 3. 回滚保障规范 (Rollback Policy)

任何上线变更若引发以下任一故障，必须立即执行无条件回滚：

1. 任一测试用例失败或架构不变性测试报错；
2. 调度器出现不可预期的任务半状态或孤儿进程；
3. 断路器未在 `ACCOUNT_POLICY` 故障下正确闭锁；
4. 审计日志出现未脱敏的凭据或 prompt/response 数据。

回滚方式：直接回退 Git Commit 至当前 Freeze 基线，并恢复 `tasks/` 和 `runtime/` 的快照。
