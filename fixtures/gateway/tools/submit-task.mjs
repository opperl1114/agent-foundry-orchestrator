// fixtures/gateway/tools/submit-task.mjs
//
// Minimal self-contained stand-in for the agent-foundry-gateway
// foundry_submit_task tool, so the conversation-gateway tests can run without
// the sibling gateway repository checked out next to this one.
//
// It mirrors the gateway CONTRACT only:
//   1. forgeable governance fields are rejected fail-closed (governance_rejected)
//   2. anything that is not a canonical capsule field is stripped
//   3. the submission is delegated strictly through orchestrator.submitTask
//      (ROLE != PLATFORM: the entry layer never binds an executor or a role)
//
// Point AF_GATEWAY_DIR / AF_GATEWAY_SERVER at the real gateway to exercise it
// instead of this fixture.

export const FORBIDDEN_GOVERNANCE_FIELDS = Object.freeze([
  'publish',
  'published',
  'published_path',
  'policy_decision',
  'human_gate_status',
  'human_required',
  'governance_bypass',
  'governance_source',
  'candidate_id',
  'agent_instance_id',
  'formal_review_decision',
]);

// The only capsule fields the conversation entry layer may forward.
export const ALLOWED_CAPSULE_FIELDS = Object.freeze([
  'goal',
  'context',
  'source_agent',
  'target_path',
  'acceptance',
]);

export const submitTaskToolDefinition = Object.freeze({
  name: 'foundry_submit_task',
  description: 'Submit a new task to Agent Foundry.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the task must achieve' },
      context: { type: 'string', description: 'Supporting context' },
      source_agent: { type: 'string', description: 'Which conversation agent submitted this' },
    },
    required: ['goal'],
  },
});

function collectGovernanceViolations(payload) {
  const violations = [];
  const walk = (value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (FORBIDDEN_GOVERNANCE_FIELDS.includes(key)) violations.push(here);
      walk(child, here);
    }
  };
  walk(payload, '');
  return violations;
}

function buildCapsule(input) {
  return {
    source: 'conversation-gateway',
    created_at: new Date().toISOString(),
    ...Object.fromEntries(
      ALLOWED_CAPSULE_FIELDS
        .filter((field) => input[field] !== undefined)
        .map((field) => [field, input[field]])
    ),
  };
}

export async function submitTaskHandler(input = {}, options = {}) {
  const violations = collectGovernanceViolations(input);
  if (violations.length) {
    throw new Error(`governance_rejected: forbidden governance field(s): ${violations.join(', ')}`);
  }

  const { tasksDir = null, scheduler = null, orchestratorModule } = options;
  if (!orchestratorModule?.submitTask) {
    throw new Error('gateway_misconfigured: orchestrator module is required for submission');
  }

  const res = await orchestratorModule.submitTask(buildCapsule(input), {
    tasksDir,
    scheduler,
    withIntentGate: true,
  });

  if (res.status === 'WAITING_HUMAN') {
    return {
      task_id: res.task_id,
      status: 'WAITING_HUMAN',
      message: 'Task requires human confirmation before execution',
      intent_alignment: res.intent_alignment ?? null,
    };
  }

  return {
    task_id: res.task_id,
    status: 'ACCEPTED',
    message: 'Task submitted to Agent Foundry',
    intent_alignment: res.intent_alignment ?? null,
  };
}
