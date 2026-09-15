// fixtures/gateway/tools/approve-intent.mjs
//
// Minimal self-contained stand-in for the agent-foundry-gateway
// foundry_approve_intent tool. It delegates the human approval to
// orchestrator.approveTaskIntent, which owns the WAITING_HUMAN -> APPROVED
// transition and the Scheduler hand-off.

export const approveIntentToolDefinition = Object.freeze({
  name: 'foundry_approve_intent',
  description: 'Approve a task parked at the Human Intent Gate.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task identifier' },
      reason: { type: 'string', description: 'Why the operator approves this direction' },
    },
    required: ['task_id'],
  },
});

export async function approveIntentHandler(input = {}, options = {}) {
  const { task_id: taskId, reason } = input;
  if (!taskId) throw new Error('invalid_argument: "task_id" is required');

  const {
    tasksDir = null,
    scheduler = null,
    orchestratorModule,
    autoRun = false,
  } = options;

  if (!orchestratorModule?.approveTaskIntent) {
    throw new Error('gateway_misconfigured: orchestrator module is required');
  }

  const res = await orchestratorModule.approveTaskIntent(taskId, {
    reason: reason ?? '确认执行该方案',
    approvedBy: 'user',
    tasksDir,
    scheduler,
    autoRun,
  });

  return { task_id: res.task_id, status: res.status, message: res.message };
}
