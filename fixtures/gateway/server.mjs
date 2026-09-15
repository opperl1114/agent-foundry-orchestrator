// fixtures/gateway/server.mjs
//
// Minimal self-contained stand-in for the agent-foundry-gateway MCP entry
// layer (stdio JSON-RPC). It exists so the conversation-gateway tests can run
// without the sibling gateway repository checked out next to this one.
//
// Boundary it must keep (asserted by the tests): the entry layer delegates
// strictly through the orchestrator module it is handed and never reaches an
// executor itself.
//
// Point AF_GATEWAY_DIR / AF_GATEWAY_SERVER at the real gateway to exercise that
// instead of this fixture.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { submitTaskHandler, submitTaskToolDefinition } from './tools/submit-task.mjs';
import { taskStatusHandler, taskStatusToolDefinition } from './tools/task-status.mjs';
import { approveIntentHandler, approveIntentToolDefinition } from './tools/approve-intent.mjs';
import { rejectIntentHandler, rejectIntentToolDefinition } from './tools/reject-intent.mjs';

export const SERVER_INFO = Object.freeze({
  name: 'agent-foundry-gateway',
  version: '0.1.0',
});

export const TOOLS = Object.freeze([
  submitTaskToolDefinition,
  taskStatusToolDefinition,
  approveIntentToolDefinition,
  rejectIntentToolDefinition,
]);

const HANDLERS = Object.freeze({
  foundry_submit_task: submitTaskHandler,
  foundry_task_status: taskStatusHandler,
  foundry_approve_intent: approveIntentHandler,
  foundry_reject_intent: rejectIntentHandler,
});

export async function handleJsonRpcMessage(message, context = {}) {
  const { id = null, method, params = {} } = message ?? {};
  const options = context.options ?? {};
  const jsonrpc = message?.jsonrpc ?? '2.0';

  if (method === 'initialize') {
    return {
      jsonrpc,
      id,
      result: {
        protocolVersion: params.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc,
      id,
      result: {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc, id, result: {} };
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const handler = HANDLERS[toolName];
    if (!handler) {
      return {
        jsonrpc,
        id,
        result: { isError: true, content: [{ type: 'text', text: `unknown_tool: ${toolName}` }] },
      };
    }
    try {
      const out = await handler(params.arguments ?? {}, options);
      return {
        jsonrpc,
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(out) }] },
      };
    } catch (err) {
      return {
        jsonrpc,
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: String(err?.message ?? err) }],
        },
      };
    }
  }

  return { jsonrpc, id, error: { code: -32601, message: `method not found: ${method}` } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    handleJsonRpcMessage(message, { options: {} })
      .then((response) => process.stdout.write(`${JSON.stringify(response)}\n`))
      .catch(() => { /* the request/response contract is settled by the caller */ });
  });
}
