// fixtures/gateway/tools/reject-intent.mjs
//
// Minimal self-contained stand-in for the agent-foundry-gateway
// foundry_reject_intent tool. It delegates the rejection to
// orchestrator.rejectTaskIntent, which drives the task to CANCELLED.

export const rejectIntentToolDefinition = Object.freeze({
  name: 'foundry_reject_intent',
  description: 'Reject a task parked at the Human Intent Gate.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task identifier' },
      reason: { type: 'string', description: 'Why the operator rejects this direction' },
    },
    required: ['task_id'],
  },
});

export async function rejectIntentHandler(input = {}, options = {}) {
  const { task_id: taskId, reason } = input;
  if (!taskId) throw new Error('invalid_argument: "task_id" is required');

  const { tasksDir = null, orchestratorModule } = options;
  if (!orchestratorModule?.rejectTaskIntent) {
    throw new Error('gateway_misconfigured: orchestrator module is required');
  }

  const res = await orchestratorModule.rejectTaskIntent(taskId, {
    reason: reason ?? '方向不符合要求',
    rejectedBy: 'user',
    tasksDir,
  });

  return { task_id: res.task_id, status: res.status, message: res.message };
}
