// tests/architecture-invariant.test.mjs - Architecture Invariant Verification
//
// Invariants enforced:
//   1. No Second Registry: Capability source of truth is strictly agent-foundry-global/executors/*.json.
//   2. No Second Scheduler: Only orchestrator.mjs and lib/scheduler.mjs drive execution.
//   3. Governance Bypass Forbidden: All governed tasks must declare governance_env explicitly and route through GovernanceBridge.
//   4. No Credential Persistence: 0 tokens, API keys, credentials, or prompts/responses on disk.
//   5. ROLE != PLATFORM: Adapters and router strictly decouple platform identity from task roles.

import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadExecutorStatus, EXECUTORS_DIR } from '../lib/executor-status.mjs';
import { resolveExecutorRoute } from '../lib/executor-router.mjs';
import { ADAPTERS } from '../lib/adapters.mjs';
import { GovernanceBridge, classifyPublishVerdict } from '../lib/governance.mjs';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// ----------------------------------------------------------------------------
// TEST INV-1: No Second Registry
// ----------------------------------------------------------------------------
test('INV-1: No Second Registry: executor capability truth is strictly global', () => {
  // 1. Verify that orchestrator root contains NO duplicate executors registry directory
  const localExecutorsDir = join(ROOT_DIR, 'executors');
  assert.strictEqual(
    existsSync(localExecutorsDir),
    false,
    'Orchestrator must NOT contain a local executors/ registry directory'
  );

  // 2. Verify loadExecutorStatus loads from agent-foundry-global/executors
  assert.match(
    EXECUTORS_DIR,
    /agent-foundry-global\/executors/,
    'EXECUTORS_DIR must point to agent-foundry-global/executors'
  );

  const statusMap = loadExecutorStatus();
  assert(statusMap.size > 0, 'Global registry must provide at least one executor');

  // Verify all entries originate from .json files in the global directory
  for (const [id, desc] of statusMap.entries()) {
    assert(desc.capability_status, `Executor ${id} must have capability_status from global descriptor`);
    assert(desc.source, `Executor ${id} must track its global descriptor source`);
    assert(
      desc.source.startsWith(EXECUTORS_DIR),
      `Executor descriptor path must be inside ${EXECUTORS_DIR}`
    );
  }
});

// ----------------------------------------------------------------------------
// TEST INV-2: No Second Scheduler
// ----------------------------------------------------------------------------
test('INV-2: No Second Scheduler: single-engine state machine truth', () => {
  const libDir = join(ROOT_DIR, 'lib');
  const libFiles = readdirSync(libDir);

  // Check for competing schedulers, background queue workers, or daemons
  const forbiddenPatterns = [
    /daemon/i,
    /queue/i,
    /worker-pool/i,
    /second-scheduler/i,
    /alt-scheduler/i,
  ];

  for (const file of libFiles) {
    for (const pattern of forbiddenPatterns) {
      assert.strictEqual(
        pattern.test(file),
        false,
        `Forbidden secondary execution component found in lib/: ${file}`
      );
    }
  }

  // Verify scheduler.mjs is the exclusive state machine engine
  const schedulerFile = join(libDir, 'scheduler.mjs');
  assert.strictEqual(existsSync(schedulerFile), true, 'scheduler.mjs must exist as primary engine');
  const schedulerCode = readFileSync(schedulerFile, 'utf8');
  assert(
    schedulerCode.includes('class Scheduler'),
    'scheduler.mjs must define the unified Scheduler class'
  );
});

// ----------------------------------------------------------------------------
// TEST INV-3: Governance Bypass Forbidden
// ----------------------------------------------------------------------------
test('INV-3: Governance Bypass Forbidden: local forgery is rejected fail-closed', () => {
  // 1. Without explicit vaultRoot, construction must fail closed
  assert.throws(
    () => new GovernanceBridge({ task_id: 'TASK-GOV-001' }),
    /GOVERNANCE_ENV_REQUIRED/,
    'Must fail closed when vaultRoot is missing'
  );

  // 2. Verify classifyPublishVerdict strictly evaluates policy and outcome
  const humanVerdict = classifyPublishVerdict({ policy_decision: 'human_required', published: false });
  assert.strictEqual(humanVerdict, 'human_required', 'Must remain human_required without approval');

  const denyVerdict = classifyPublishVerdict({ policy_decision: 'deny' });
  assert.strictEqual(denyVerdict, 'deny', 'Deny verdict must fail closed');

  // Agent trying to claim published: false with policy_decision: 'auto_publish'
  const autoVerdict = classifyPublishVerdict({ policy_decision: 'auto_publish' });
  assert.strictEqual(autoVerdict, 'published', 'Auto publish produces published verdict');
});

// ----------------------------------------------------------------------------
// TEST INV-4: No Credential Persistence
// ----------------------------------------------------------------------------
test('INV-4: No Credential Persistence: scans runtime and tasks for zero secret leakage', () => {
  const dirsToScan = [
    join(ROOT_DIR, 'tasks'),
    join(ROOT_DIR, 'runtime'),
    join(ROOT_DIR, 'locks'),
  ];

  const forbiddenKeyRegex = /("token"\s*:|"api_key"\s*:|"secret"\s*:|"password"\s*:|"bearer\s+[a-zA-Z0-9_\-\.]+)/i;

  for (const dir of dirsToScan) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    for (const file of files) {
      const p = join(dir, file);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isFile()) {
        let content;
        try { content = readFileSync(p, 'utf8'); } catch { continue; }
        assert.strictEqual(
          forbiddenKeyRegex.test(content),
          false,
          `Credential or token pattern detected in persisted file: ${p}`
        );
      }
    }
  }

  // Check event sanitizer in ExecutorRuntimeGuard
  const tmpDir = mkdtempSync(join(tmpdir(), 'af-inv4-'));
  try {
    const eventsLogFile = join(tmpDir, 'test-events.jsonl');
    const guard = new ExecutorRuntimeGuard({ eventsLogFile });
    guard.appendAuditEvent({
      executor: 'vertex-gemini',
      event: 'TEST_EVENT',
      reason: 'test_reason',
      prompt: 'sensitive prompt text',
      response: 'sensitive model output',
      token: 'secret-token-xyz',
      auth: 'bearer 12345',
      secret: 'super-secret',
    });

    const logged = readFileSync(eventsLogFile, 'utf8');
    const parsed = JSON.parse(logged.trim());

    assert.strictEqual(parsed.prompt, undefined, 'Sanitizer must strip prompt');
    assert.strictEqual(parsed.response, undefined, 'Sanitizer must strip response');
    assert.strictEqual(parsed.token, undefined, 'Sanitizer must strip token');
    assert.strictEqual(parsed.auth, undefined, 'Sanitizer must strip auth');
    assert.strictEqual(parsed.secret, undefined, 'Sanitizer must strip secret');
    assert.strictEqual(parsed.reason, 'test_reason', 'Sanitizer preserves safe reason');
    assert.strictEqual(parsed.executor, 'vertex-gemini', 'Sanitizer preserves executor');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST INV-5: Strict Separation of ROLE != PLATFORM
// ----------------------------------------------------------------------------
test('INV-5: Strict Separation of ROLE != PLATFORM in adapters and router', () => {
  // 1. Adapters must not restrict role
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    assert(typeof adapter.run === 'function', `Adapter ${name} must implement run()`);
    assert(typeof adapter.resume === 'function', `Adapter ${name} must implement resume()`);
    assert(typeof adapter.cancel === 'function', `Adapter ${name} must implement cancel()`);
    assert(typeof adapter.health === 'function', `Adapter ${name} must implement health()`);

    // Ensure adapters do not export hardcoded role bindings
    assert.strictEqual(
      adapter.assigned_role,
      undefined,
      `Adapter ${name} must not have hardcoded assigned_role`
    );
  }

  // 2. Router must produce deterministic outcome regardless of role
  const capMap = new Map([
    ['claude', { status: 'READY', supports_mcp: true, supports_terminal: true }],
    ['vertex-gemini', { status: 'READY', supports_mcp: true, supports_terminal: true }],
  ]);
  const availMap = new Map([
    ['claude', { status: 'READY' }],
    ['vertex-gemini', { status: 'READY' }],
  ]);
  const guard = new ExecutorRuntimeGuard();

  // Route as author
  const authorRoute = resolveExecutorRoute(
    { author_executor: 'auto', requirements: { terminal: true } },
    {
      role: 'author',
      capabilityMap: capMap,
      availabilityMap: availMap,
      runtimeGuard: guard,
    }
  );

  // Route as reviewer
  const reviewerRoute = resolveExecutorRoute(
    { reviewer_executor: 'auto', requirements: { terminal: true } },
    {
      role: 'reviewer',
      capabilityMap: capMap,
      availabilityMap: availMap,
      runtimeGuard: guard,
    }
  );

  assert.strictEqual(
    authorRoute.primary,
    reviewerRoute.primary,
    'Router must treat candidates strictly by capability, availability, and runtime state, not by role'
  );
  assert.deepStrictEqual(
    authorRoute.fallbacks,
    reviewerRoute.fallbacks,
    'Router fallbacks must match across roles for same capability/availability constraints'
  );
  assert(authorRoute.primary, 'Must select valid primary');
});
