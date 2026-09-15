// fixtures/gateway/tools/task-status.mjs
//
// Minimal self-contained stand-in for the agent-foundry-gateway
// foundry_task_status tool. It is a read-only projection delegated to
// orchestrator.getTaskStatus - it never mutates a task.

export const taskStatusToolDefinition = Object.freeze({
  name: 'foundry_task_status',
  description: 'Read the current state of a submitted task.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'Task identifier' },
    },
    required: ['task_id'],
  },
});

export async function taskStatusHandler(input = {}, options = {}) {
  const { task_id: taskId } = input;
  if (!taskId) throw new Error('invalid_argument: "task_id" is required');

  const { tasksDir = null, orchestratorModule } = options;
  if (!orchestratorModule?.getTaskStatus) {
    throw new Error('gateway_misconfigured: orchestrator module is required');
  }

  return orchestratorModule.getTaskStatus(taskId, { tasksDir });
}
