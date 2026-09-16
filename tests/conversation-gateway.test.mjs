// tests/conversation-gateway.test.mjs - PHASE 9-A MCP Entry Layer Tests
//
// Tests:
//   TEST CG-1: MCP Server 启动成功
//   TEST CG-2: 调用 foundry_submit_task 生成合法 Task
//   TEST CG-3: Task 进入现有 Orchestrator
//   TEST CG-4: Gateway 不能直接调用 executor
//   TEST CG-5: 非法 governance 字段被拒绝
//   TEST CG-6: 未知参数不会污染 Task Schema

import { test } from 'node:test';
import './helpers/executors-fixture.mjs';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as orchestrator from '../orchestrator.mjs';
import { Scheduler } from '../lib/scheduler.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// The conversation gateway entry layer lives in its own repository. When that
// sibling checkout is absent (a fresh machine, CI) the tests run against the
// self-contained fixture of the same contract, so the suite stays hermetic.
// AF_GATEWAY_DIR / AF_GATEWAY_SERVER point the tests at a real gateway.
const GATEWAY_DIR = process.env.AF_GATEWAY_DIR ||
  (existsSync(join(ROOT_DIR, '../agent-foundry-gateway'))
    ? join(ROOT_DIR, '../agent-foundry-gateway')
    : join(ROOT_DIR, 'fixtures', 'gateway'));
const GATEWAY_SERVER_PATH = process.env.AF_GATEWAY_SERVER || join(GATEWAY_DIR, 'server.mjs');

const { handleJsonRpcMessage, TOOLS, SERVER_INFO } =
  await import(pathToFileURL(GATEWAY_SERVER_PATH).href);
const { submitTaskHandler, FORBIDDEN_GOVERNANCE_FIELDS } =
  await import(pathToFileURL(join(GATEWAY_DIR, 'tools', 'submit-task.mjs')).href);
const { taskStatusHandler } =
  await import(pathToFileURL(join(GATEWAY_DIR, 'tools', 'task-status.mjs')).href);

function createTempDir(prefix = 'af-cg-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ----------------------------------------------------------------------------
// TEST CG-1: MCP Server 启动成功
// ----------------------------------------------------------------------------
test('TEST CG-1: MCP Server 启动成功 (stdio JSON-RPC initialize and tools/list)', async () => {
  const child = spawn(process.execPath, [GATEWAY_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  try {
    let stdoutBuffer = '';
    const responses = [];

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop(); // keep remainder
      for (const line of lines) {
        if (line.trim()) {
          try {
            responses.push(JSON.parse(line.trim()));
          } catch { /* ignore parse */ }
        }
      }
    });

    const sendRequest = (req) => {
      child.stdin.write(JSON.stringify(req) + '\n');
    };

    // 1. Send initialize
    sendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'test-runner', version: '1.0.0' },
      },
    });

    // Wait for response 1
    const deadline = Date.now() + 5000;
    while (!responses.find((r) => r.id === 1) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const initResp = responses.find((r) => r.id === 1);
    assert(initResp, 'Server must respond to initialize request');
    assert.strictEqual(initResp.result.serverInfo.name, 'agent-foundry-gateway');
    assert.strictEqual(initResp.result.serverInfo.version, '0.1.0');
    assert(initResp.result.capabilities?.tools, 'Server must advertise tools capability');

    // 2. Send tools/list
    sendRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    while (!responses.find((r) => r.id === 2) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const toolsResp = responses.find((r) => r.id === 2);
    assert(toolsResp, 'Server must respond to tools/list request');
    const toolNames = toolsResp.result.tools.map((t) => t.name);
    assert(toolNames.includes('foundry_submit_task'), 'Must expose foundry_submit_task');
    assert(toolNames.includes('foundry_task_status'), 'Must expose foundry_task_status');

    // 3. Send ping
    sendRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'ping',
      params: {},
    });
    while (!responses.find((r) => r.id === 3) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pingResp = responses.find((r) => r.id === 3);
    assert(pingResp, 'Server must respond to ping');
    assert.deepStrictEqual(pingResp.result, {});

  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
});

// ----------------------------------------------------------------------------
// TEST CG-2: 调用 foundry_submit_task 生成合法 Task
// ----------------------------------------------------------------------------
test('TEST CG-2: 调用 foundry_submit_task 生成合法 Task', async () => {
  const tmpTasksDir = createTempDir('af-cg2-tasks-');
  try {
    const input = {
      goal: '整理我的 Java 面试知识库',
      context: '要求：生成目录 去重 写入知识库',
      source_agent: 'antigravity',
    };

    const res = await submitTaskHandler(input, {
      tasksDir: tmpTasksDir,
      orchestratorModule: orchestrator,
    });

    // 1. Verify return structure
    assert.match(res.task_id, /^TASK-\d{8}-[A-Z0-9]+$/, 'task_id must follow standard TASK-YYYYMMDD-XXXX format');
    assert.strictEqual(res.status, 'ACCEPTED', 'status must be ACCEPTED');
    assert.strictEqual(res.message, 'Task submitted to Agent Foundry');

    // 2. Verify task file generated on disk
    const taskFilePath = join(tmpTasksDir, `${res.task_id}.json`);
    assert.strictEqual(existsSync(taskFilePath), true, `Task file ${taskFilePath} must exist on disk`);

    const taskContent = JSON.parse(readFileSync(taskFilePath, 'utf8'));

    // 3. Verify task schema fields
    assert.strictEqual(taskContent.task_id, res.task_id);
    assert.strictEqual(taskContent.state, 'READY');
    assert.strictEqual(taskContent.source, 'conversation-gateway');
    assert.strictEqual(taskContent.source_agent, 'antigravity');
    assert.strictEqual(taskContent.goal, '整理我的 Java 面试知识库');
    assert.strictEqual(taskContent.context, '要求：生成目录 去重 写入知识库');
    assert(taskContent.created_at, 'created_at timestamp must exist');
    assert(Array.isArray(taskContent.runs), 'runs array must be initialized');

    // Also test via MCP JSON-RPC message dispatcher
    const rpcResp = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'foundry_submit_task',
        arguments: {
          goal: '测试 MCP RPC 提交接口',
          context: '验证 JSON-RPC 链路',
          source_agent: 'claude',
        },
      },
    }, {
      options: { tasksDir: tmpTasksDir, orchestratorModule: orchestrator },
    });

    assert.strictEqual(rpcResp.id, 10);
    assert(rpcResp.result?.content?.[0]?.text, 'Must contain text response');
    const parsedOut = JSON.parse(rpcResp.result.content[0].text);
    assert.strictEqual(parsedOut.status, 'ACCEPTED');
    assert(existsSync(join(tmpTasksDir, `${parsedOut.task_id}.json`)));

  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST CG-3: Task 进入现有 Orchestrator
// ----------------------------------------------------------------------------
test('TEST CG-3: Task进入现有 Orchestrator (Orchestrator -> Scheduler -> Router)', async () => {
  const tmpTasksDir = createTempDir('af-cg3-tasks-');
  try {
    const input = {
      goal: '端到端 Orchestrator 入口编排验证',
      context: '验证 Gateway 提交后能够被既存 Scheduler 正确管理',
      source_agent: 'codex',
    };

    // 1. Instantiate existing Scheduler pointing to isolated tasksDir
    const reviewObj = {
      decision: 'PASS',
      summary: 'LGTM',
      issues: [],
      required_changes: [],
      evidence: ['evidence verified'],
    };
    const makeFakeAdapter = (type) => ({
      type,
      run: async (capsule) => ({
        executor_run_id: 'RUN-CG3-' + Math.random().toString(36).slice(2, 8),
        executor_type: type,
        assigned_role: capsule.assigned_role,
        status: 'completed',
        session_ref: 'SES-' + type,
        structured_result: {
          result: JSON.stringify(reviewObj),
          parsed: reviewObj,
        },
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      }),
      resume: async () => ({ status: 'completed' }),
      cancel: () => ({ requested: true, pid: null }),
      health: () => ({ status: 'READY' }),
    });

    const sched = new Scheduler({
      tasksDir: tmpTasksDir,
      adapters: {
        'vertex-gemini': makeFakeAdapter('vertex-gemini'),
        claude: makeFakeAdapter('claude'),
        codex: makeFakeAdapter('codex'),
        antigravity: makeFakeAdapter('antigravity'),
      },
    });

    // 2. Submit through Gateway -> orchestrator.submitTask -> sched.enqueue
    const submitRes = await submitTaskHandler(input, {
      tasksDir: tmpTasksDir,
      scheduler: sched,
      orchestratorModule: orchestrator,
    });
    const taskId = submitRes.task_id;

    // Verify task entered Scheduler queue
    assert(sched.queue.includes(taskId) || sched.active.has(taskId), 'Task must enter Scheduler queue');

    // 3. Query status immediately via foundry_task_status
    const initialStatus = await taskStatusHandler({ task_id: taskId }, {
      tasksDir: tmpTasksDir,
      orchestratorModule: orchestrator,
    });
    assert.strictEqual(initialStatus.task_id, taskId);
    assert.strictEqual(initialStatus.state, 'READY');

    // 4. Verify task is loaded and recognized by orchestrator
    const loaded = orchestrator.getTaskStatus(taskId, { tasksDir: tmpTasksDir });
    assert.strictEqual(loaded.task_id, taskId);
    assert.strictEqual(loaded.state, 'READY');

    // Run task in Scheduler
    sched.runNext();
    await sched.waitAll();

    // 5. Verify task settled in COMPLETED state through Scheduler orchestration
    const finishedStatus = await taskStatusHandler({ task_id: taskId }, {
      tasksDir: tmpTasksDir,
      orchestratorModule: orchestrator,
    });
    assert.strictEqual(finishedStatus.state, 'COMPLETED');
    assert(finishedStatus.executor, 'Executor must be recorded');

  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST CG-4: Gateway 不能直接调用 executor
// ----------------------------------------------------------------------------
test('TEST CG-4: Gateway不能直接调用executor (架构边界与静态代码不变性)', () => {
  const gatewayDir = GATEWAY_DIR;
  assert(existsSync(gatewayDir), 'the conversation gateway entry layer must exist');

  // Collect all JS/MJS source files in gateway
  const filesToScan = [
    join(gatewayDir, 'server.mjs'),
    join(gatewayDir, 'tools', 'submit-task.mjs'),
    join(gatewayDir, 'tools', 'task-status.mjs'),
  ];

  const forbiddenExecutionPatterns = [
    /adapters\.mjs/i,
    /ADAPTERS/i,
    /executeTask\s*\(/i,
    /runAuthor\s*\(/i,
    /runReviewer\s*\(/i,
    /spawn\s*\(\s*['"`](agy|claude|codex|vertex-gemini)/i,
    /bin\/agy-af/i,
    /bin\/claude-af/i,
    /bin\/vertex-gemini-af/i,
  ];

  for (const file of filesToScan) {
    assert(existsSync(file), `Gateway file ${file} must exist`);
    const code = readFileSync(file, 'utf8');

    for (const pattern of forbiddenExecutionPatterns) {
      assert.strictEqual(
        pattern.test(code),
        false,
        `Gateway file ${file} violates invariant: contains direct executor call or adapter binding (${pattern})`
      );
    }
  }

  // Verify that Gateway only calls orchestrator.mjs / submitTask
  const submitCode = readFileSync(join(gatewayDir, 'tools', 'submit-task.mjs'), 'utf8');
  assert(
    submitCode.includes('orchestrator.submitTask') || submitCode.includes('orchestrator'),
    'submit-task.mjs must delegate strictly through orchestrator.mjs'
  );
});

// ----------------------------------------------------------------------------
// TEST CG-5: 非法 governance 字段被拒绝
// ----------------------------------------------------------------------------
test('TEST CG-5: 非法 governance 字段被拒绝 (fail-closed boundary)', async () => {
  const tmpTasksDir = createTempDir('af-cg5-tasks-');

  try {
    const illegalCases = [
      { goal: 'test', publish: true },
      { goal: 'test', policy_decision: 'auto_publish' },
      { goal: 'test', human_gate_status: 'approved' },
      { goal: 'test', governance_bypass: true },
      { goal: 'test', candidate_id: 'CAND-HACKED-001' },
      { goal: 'test', agent_instance_id: 'FORGED-AGENT-ID' },
      { goal: 'test', formal_review_decision: 'approve' },
      { goal: 'test', metadata: { publish: true } },
      { goal: 'test', metadata: { policy_decision: 'auto_publish' } },
      { goal: 'test', metadata: { human_gate_status: 'approved' } },
    ];

    for (const badPayload of illegalCases) {
      // 1. Direct handler test: must throw governance_rejected error
      await assert.rejects(
        async () => {
          await submitTaskHandler(badPayload, {
            tasksDir: tmpTasksDir,
            orchestratorModule: orchestrator,
          });
        },
        /governance_rejected/,
        `Payload ${JSON.stringify(badPayload)} must be rejected with governance_rejected error`
      );

      // 2. MCP JSON-RPC message test: must return isError: true with error text
      const rpcResp = await handleJsonRpcMessage({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: 'foundry_submit_task',
          arguments: badPayload,
        },
      }, {
        options: { tasksDir: tmpTasksDir, orchestratorModule: orchestrator },
      });

      assert(rpcResp.result?.isError === true, 'JSON-RPC response must have isError: true');
      assert.match(rpcResp.result.content[0].text, /governance_rejected/);
    }

    // 3. Confirm zero tasks were persisted on disk
    const files = readdirSync(tmpTasksDir);
    assert.strictEqual(files.length, 0, 'No task files should be created for rejected submissions');

  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST CG-6: 未知参数不会污染 Task Schema
// ----------------------------------------------------------------------------
test('TEST CG-6: 未知参数不会污染 Task Schema', async () => {
  const tmpTasksDir = createTempDir('af-cg6-tasks-');

  try {
    const dirtyPayload = {
      goal: 'Clean Task Schema Test',
      context: 'Verify filtering of unknown parameters',
      source_agent: 'antigravity',
      // Injected / unknown fields:
      unknown_field_1: 'polluting_string',
      injected_number: 123456,
      hacked_object: { secret: 'bypass' },
      priority_override: 'critical',
      author_executor: 'claude',      // ROLE != PLATFORM: Gateway must NOT accept hardcoded executor
      reviewer_executor: 'antigravity', // ROLE != PLATFORM: Gateway must NOT accept hardcoded executor
      assigned_role: 'boss',
      fallback: ['vertex-gemini'],
    };

    const res = await submitTaskHandler(dirtyPayload, {
      tasksDir: tmpTasksDir,
      orchestratorModule: orchestrator,
    });

    const taskFilePath = join(tmpTasksDir, `${res.task_id}.json`);
    assert(existsSync(taskFilePath), 'Task file must exist');

    const taskOnDisk = JSON.parse(readFileSync(taskFilePath, 'utf8'));

    // Verify canonical fields exist
    assert.strictEqual(taskOnDisk.task_id, res.task_id);
    assert.strictEqual(taskOnDisk.state, 'READY');
    assert.strictEqual(taskOnDisk.source, 'conversation-gateway');
    assert.strictEqual(taskOnDisk.source_agent, 'antigravity');
    assert.strictEqual(taskOnDisk.goal, 'Clean Task Schema Test');
    assert.strictEqual(taskOnDisk.context, 'Verify filtering of unknown parameters');

    // Verify NONE of the dirty / unknown fields polluted the task capsule schema
    assert.strictEqual(taskOnDisk.unknown_field_1, undefined, 'unknown_field_1 must be stripped');
    assert.strictEqual(taskOnDisk.injected_number, undefined, 'injected_number must be stripped');
    assert.strictEqual(taskOnDisk.hacked_object, undefined, 'hacked_object must be stripped');
    assert.strictEqual(taskOnDisk.priority_override, undefined, 'priority_override must be stripped');

    // Verify ROLE != PLATFORM: Gateway did not bind executor/role fields
    assert.strictEqual(taskOnDisk.author_executor, undefined, 'Gateway must not set author_executor');
    assert.strictEqual(taskOnDisk.reviewer_executor, undefined, 'Gateway must not set reviewer_executor');
    assert.strictEqual(taskOnDisk.assigned_role, undefined, 'Gateway must not set assigned_role');
    assert.strictEqual(taskOnDisk.fallback, undefined, 'Gateway must not set fallback');

  } finally {
    rmSync(tmpTasksDir, { recursive: true, force: true });
  }
});
