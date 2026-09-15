# SECURITY_AUDIT.md — 生产安全与敏感数据隔离审计报告

本文件记录 Agent Foundry Orchestrator 在生产运行前对敏感凭证、Prompt/Response 泄露、命令注入以及跨平面越权的静态与动态全面审计结果。

---

## 1. 敏感凭证与日志泄露静态扫描

审计范围涵盖系统运行过程中产生的所有数据目录：
- `runtime/`（包含熔断状态、调度元数据、事件审计日志、运行句柄）
- `tasks/`（所有持久化任务文件）
- `locks/`（所有锁文件）

### 1.1 凭证与密钥模式匹配扫描
对上述目录执行正则与高危敏感词模式匹配扫描：
`pattern: (bearer|api_key|token|password|secret|credential)["']?\s*[:=]\s*["']?[a-zA-Z0-9_\-\.]{8,}`

- **扫描结果**：**0 匹配项（Zero Match）**。
- **环境注入验证**：执行器认证凭证（如 GCP ADC、`VERTEX_API_KEY`、Claude proxy 内部认证）严格由系统运行时环境变量直接注入执行子进程，绝不落地保存于任何持久化 JSON 或日志中。

### 1.2 运行时审计日志白名单脱敏验证 (`lib/executor-runtime-guard.mjs`)
在 `appendAuditEvent` 核心函数中，强制实施硬性过滤集合：
```javascript
const FORBIDDEN = new Set(['prompt', 'response', 'token', 'credential', 'password', 'key', 'secret', 'auth']);
```
对现存 `runtime/executor-runtime-events.jsonl` 中全部 109 条审计事件进行键名遍历核查：
- 出现的键集合：`['executor', 'event', 'category', 'reason', 'timestamp', 'circuit_state', 'reset_by']`
- 敏感字段命中数：**0 项**。
- 结论：不存在 Prompt 文本落盘、大模型完整 Response 堆积、以及认证凭证泄漏问题。

---

## 2. 关键安全信任边界审计

### 2.1 验收命令信任边界（Acceptance Command Trust Boundary）
- **风险防范**：防止不可信的模型输出伪造执行操作系统 Shell 命令。
- **防御机制**（[`lib/acceptance.mjs`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/lib/acceptance.mjs)）：
  1. 验收命令严格仅能从任务定义文件（`tasks/<id>.json`）的 `acceptance_cmd` 读取；
  2. 默认禁止任何未转义的 legacy shell 字符串（强制拆分为 `{ command, args: [] }` 安全形式）；
  3. 执行器产出的文本、结构化字段、甚至声明的命令均被视为只读数据，**严禁被提取为执行命令**（在 `TEST E` 中持续通过验证）。

### 2.2 治理平面与权威隔离（Governance Plane Isolation）
- **风险防范**：防止 Agent 伪造已发布状态、伪造审批决策、或绕过 Human Gate。
- **防御机制**（[`lib/governance.mjs`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/lib/governance.mjs) & [`orchestrator.mjs`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/orchestrator.mjs)）：
  1. 治理唯一真源为 `vault-mcp`；本地 `task.governance` 仅作为只读镜像；
  2. 恢复与恢复查询时，以 `candidate_id` 为唯一关联键向 Vault 实时验证，忽略本地任何声称的 `approved` 或 `auto_publish`；
  3. 未配置显式 `governance_env.vault_root` 时，任务 Fail-Closed，严禁隐式回退到主机真实知识库。

### 2.3 策略与鉴权失败 Fail-Closed 铁律
- **风险防范**：执行器报出 403 / 账号禁用时，防止调度器误作为临时抖动重试，或降级回退到其它执行器造成上下文泄露。
- **防御机制**（[`lib/scheduler.mjs`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/lib/scheduler.mjs)）：
  - 遇到 `ACCOUNT_POLICY` 或 `AUTH_FAILURE`，调度器直接判定终态 `FAILED`；
  - 零重试（`attempt = 0`）、零 Fallback（`fallbacks = []` 不予触发）；
  - `TEST PROD-2` 与 `6C-7` 验证了该 Fail-Closed 机制百分之百生效。

### 2.4 执行器环境隔离（Executor Isolation）
- 独立 Reviewer 强制要求 `reviewer_executor_run_id != author_executor_run_id`，且当平台相同时强制要求会话标识独立（`reviewer.session_ref != author.session_ref`）。
- 跨执行器 Fallback 时彻底清空 `author_session_ref` 与会话类型，绝不将平台特定上下文注入另一平台。

---

## 3. 安全审计结论

1. **凭证安全性**：无 Token、无密码、无私钥落盘，达到 Production 零泄露基线。
2. **命令注入防范**：结构化命令隔离完好，外部不可信文本无法提升权限。
3. **审计追溯性**：关键生命周期事件与熔断操作员身份均有据可查。
4. **结论**：系统通过安全边界审计，准予进入生产冻结。
