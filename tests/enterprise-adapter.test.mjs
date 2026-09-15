// enterprise-adapter.test.mjs - PHASE 6-A Enterprise Executor Adapter tests
//
// Tests:
//   TEST 6A-1: vertex adapter run returns standard ExecutorResult
//   TEST 6A-2: resume preserves exact session_ref
//   TEST 6A-3: cancel produces standard cancelEvidence
//   TEST 6A-4: health returns standard health status
//   TEST 6A-5: ROLE != PLATFORM: same vertex executor acts dynamically as author and reviewer

import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VertexGeminiAdapter, ADAPTERS } from '../lib/adapters.mjs';

const WORK = mkdtempSync(join(tmpdir(), 'af-6a-test-'));
after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

test('TEST 6A-1: vertex adapter run returns standard ExecutorResult', async () => {
  const capsule = {
    task_id: 'TASK-6A-1',
    assigned_role: 'author',
    prompt: 'Create enterprise feature specification for Vertex AI integration',
    cwd: WORK,
    timeout_ms: 10000,
  };

  const result = await VertexGeminiAdapter.run(capsule);

  // Standard ExecutorResult schema assertions
  assert.ok(result, 'result must exist');
  assert.ok(typeof result.executor_run_id === 'string' && result.executor_run_id.startsWith('RUN-'), 'executor_run_id must start with RUN-');
  assert.strictEqual(result.executor_type, 'vertex-gemini');
  assert.strictEqual(result.assigned_role, 'author');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.exit_code, 0);
  assert.ok(typeof result.session_ref === 'string' && result.session_ref.length > 0, 'session_ref must be non-empty string');
  assert.ok(result.structured_result, 'structured_result must be present');
  assert.ok(typeof result.structured_result.result === 'string', 'structured_result.result must be string');
  assert.ok(result.started_at && !Number.isNaN(Date.parse(result.started_at)), 'started_at must be valid ISO date');
  assert.ok(result.finished_at && !Number.isNaN(Date.parse(result.finished_at)), 'finished_at must be valid ISO date');
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.error_classification?.category, 'SUCCESS');
});

test('TEST 6A-2: resume preserves exact session_ref', async () => {
  const fixedSession = 'vg-sess-audit-fixed-42';
  const capsule = {
    task_id: 'TASK-6A-2',
    assigned_role: 'author',
    prompt: 'Iterate on enterprise feature specification',
    cwd: WORK,
    timeout_ms: 10000,
  };

  const result = await VertexGeminiAdapter.resume(fixedSession, capsule);

  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(result.executor_type, 'vertex-gemini');
  assert.strictEqual(result.assigned_role, 'author');
  assert.strictEqual(result.session_ref, fixedSession, 'session_ref must be preserved exactly on resume (Exact Resume)');
  assert.strictEqual(result.error, null);
});

test('TEST 6A-3: cancel produces standard cancelEvidence', async () => {
  const runId = 'RUN-6A-CANCEL-99';
  const capsule = {
    runId,
    task_id: 'TASK-6A-3',
    assigned_role: 'author',
    prompt: '__AF_HANG__',
    cwd: WORK,
    timeout_ms: 15000,
  };

  const runPromise = VertexGeminiAdapter.run(capsule);

  // Give process time to pass pacing (min_interval_ms=200) and register in activeRuns
  await new Promise((r) => setTimeout(r, 400));

  // Request cancel on active runId
  const evidence = await VertexGeminiAdapter.cancel(runId);

  // Standard cancelEvidence assertions
  assert.ok(evidence, 'cancelEvidence must be returned');
  assert.strictEqual(evidence.run_id, runId);
  assert.strictEqual(evidence.already_exited, false);
  assert.ok(typeof evidence.pid === 'number' && evidence.pid > 0, 'must have real process PID');
  assert.strictEqual(evidence.termination_signal, 'SIGTERM');
  assert.strictEqual(evidence.process_exit_observed, 'observed');

  // Verify run resolves with cancelled status
  const runResult = await runPromise;
  assert.strictEqual(runResult.status, 'cancelled');
  assert.match(runResult.error, /cancelled by operator/i);
  assert.strictEqual(runResult.error_classification?.category, 'TRANSIENT_FAULT');
});

test('TEST 6A-4: health returns standard health status', async () => {
  const health = VertexGeminiAdapter.health();

  assert.ok(health, 'health object must exist');
  assert.strictEqual(health.executor_type, 'vertex-gemini');
  assert.strictEqual(health.ok, true);
  assert.match(health.governance, /AGENTS\.md/);
  assert.ok(typeof health.launcher === 'string' && health.launcher.length > 0);
});

test('TEST 6A-5: ROLE != PLATFORM: same vertex executor acts dynamically as author and reviewer', async () => {
  // 1. Run as author
  const authorCapsule = {
    task_id: 'TASK-6A-5A',
    assigned_role: 'author',
    prompt: 'Implement feature draft',
    cwd: WORK,
    timeout_ms: 10000,
  };

  const authorResult = await VertexGeminiAdapter.run(authorCapsule);
  assert.strictEqual(authorResult.executor_type, 'vertex-gemini');
  assert.strictEqual(authorResult.assigned_role, 'author');
  assert.strictEqual(authorResult.status, 'completed');

  // 2. Run as reviewer with response_schema
  const reviewerCapsule = {
    task_id: 'TASK-6A-5B',
    assigned_role: 'reviewer',
    prompt: 'Review the author patch against governance rules',
    response_schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['PASS', 'NEEDS_FIX'] },
        summary: { type: 'string' },
        issues: { type: 'array' },
        required_changes: { type: 'array' },
        evidence: { type: 'array' },
      },
      required: ['decision', 'summary'],
    },
    cwd: WORK,
    timeout_ms: 10000,
  };

  const reviewerResult = await VertexGeminiAdapter.run(reviewerCapsule);
  assert.strictEqual(reviewerResult.executor_type, 'vertex-gemini');
  assert.strictEqual(reviewerResult.assigned_role, 'reviewer');
  assert.strictEqual(reviewerResult.status, 'completed');
  assert.ok(reviewerResult.structured_result?.parsed, 'must parse structured reviewer response');
  assert.strictEqual(reviewerResult.structured_result.parsed.decision, 'PASS');

  // 3. Invariant check: ADAPTERS object and VertexGeminiAdapter have zero static role binding
  assert.strictEqual(VertexGeminiAdapter.assigned_role, undefined, 'adapter must have no static role');
  assert.strictEqual(ADAPTERS['vertex-gemini'], VertexGeminiAdapter);
});
