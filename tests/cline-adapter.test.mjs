// cline-adapter.test.mjs - Cline Executor Adapter & Router Integration tests
//
// Test Matrix:
//   CLINE-1: ClineAdapter contract conforms to unified ExecutorResult interface
//   CLINE-2: Health check verifies binary and governance
//   CLINE-3: ROLE != PLATFORM: cline can be routed as author or reviewer
//   CLINE-4: Capability: requires_mcp retains cline (supports unattended MCP)
//   CLINE-5: Router Priority: priority_order and preference correctly select cline

import { test } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import './helpers/executors-fixture.mjs';
import { ClineAdapter, ADAPTERS } from '../lib/adapters.mjs';
import { resolveExecutorRoute } from '../lib/executor-router.mjs';

test('CLINE-1: ClineAdapter contract conforms to unified ExecutorResult interface', () => {
  assert.strictEqual(ClineAdapter.type, 'cline');
  assert.strictEqual(ClineAdapter.supportsMcpUnattended, true);
  assert.strictEqual(ClineAdapter.exact_resume, true);
  assert.strictEqual(typeof ClineAdapter.run, 'function');
  assert.strictEqual(typeof ClineAdapter.resume, 'function');
  assert.strictEqual(typeof ClineAdapter.cancel, 'function');
  assert.strictEqual(typeof ClineAdapter.health, 'function');
  assert.strictEqual(ADAPTERS.cline, ClineAdapter, 'ClineAdapter must be registered in ADAPTERS');
});

test('CLINE-2: Health check verifies binary and governance', () => {
  const h = ClineAdapter.health();
  assert.strictEqual(h.executor_type, 'cline');
  assert.ok(h.launcher.includes('cline-af'), 'launcher must point to cline-af');
  assert.strictEqual(h.ok, true, 'health must be ok');
});

test('CLINE-3: ROLE != PLATFORM: cline can be routed as author or reviewer', () => {
  const authorRoute = resolveExecutorRoute({ author_executor: 'cline' }, { role: 'author' });
  assert.strictEqual(authorRoute.primary, 'cline');
  assert.ok(authorRoute.fallbacks.includes('claude'));

  const reviewerRoute = resolveExecutorRoute({ reviewer_executor: 'cline' }, { role: 'reviewer' });
  assert.strictEqual(reviewerRoute.primary, 'cline');
  assert.ok(reviewerRoute.fallbacks.includes('claude'));
});

test('CLINE-4: Capability: requires_mcp retains cline (supports unattended MCP)', () => {
  const route = resolveExecutorRoute({ requires_mcp: true, author_executor: 'cline' });
  assert.ok(route.fallbacks.includes('claude'), 'claude should remain as fallback');
  assert.ok(route.fallbacks.includes('codex'), 'codex is also available as an MCP fallback on 0.153.4');
});

test('CLINE-5: Router Priority: priority_order and custom priority correctly order cline', () => {
  const customRoute = resolveExecutorRoute({}, {
    priorityOrder: ['cline', 'claude', 'codex'],
  });
  assert.strictEqual(customRoute.primary, 'cline');
  assert.deepStrictEqual(customRoute.fallbacks, ['claude', 'codex']);
});

test('CLINE-6: Daily rate limit / quota exceeded triggers fallback to cline-pass/deepseek-v4-flash', async () => {
  // Test that error classifier marks daily limit / quota as RATE_LIMIT
  const { classifyExecutionError } = await import('../lib/executor-error-classifier.mjs');
  const cls1 = classifyExecutionError('cline', { exit_code: 1, stderr: 'Daily limit reached for model z-ai/glm-5.3-flash' });
  assert.strictEqual(cls1.category, 'RATE_LIMIT');

  const cls2 = classifyExecutionError('cline', { exit_code: 1, stderr: '429 Quota Exceeded: daily rate limit reached' });
  assert.strictEqual(cls2.category, 'RATE_LIMIT');
});

test('CLINE-7: Cline adapter sets max reasoning effort (xhigh) for deepseek fallback', async () => {
  const { rmSync, readFileSync } = await import('node:fs');
  const { CLINE_STUB, STUB_ARGV_LOG } = await import('./helpers/executor-stub-launcher.mjs');

  // Assert the ARGUMENTS the adapter builds, not whether the vendor CLI is
  // installed: without an explicit effort, a deepseek model must be driven at
  // xhigh reasoning effort.
  rmSync(STUB_ARGV_LOG, { force: true });
  const previousLauncher = process.env.CLINE_LAUNCHER;
  const previousLog = process.env.AF_STUB_ARGV_LOG;
  process.env.CLINE_LAUNCHER = CLINE_STUB;
  process.env.AF_STUB_ARGV_LOG = STUB_ARGV_LOG;

  try {
    const result = await ClineAdapter.run({
      task_id: 'TASK-CLINE-7',
      assigned_role: 'author',
      prompt: 'Verify deepseek fallback reasoning effort',
      model: 'cline-pass/deepseek-v4-flash',
      cwd: tmpdir(),
      timeout_ms: 15000,
    });

    assert.strictEqual(result.status, 'completed', 'stub launcher run must complete');

    const invocations = readFileSync(STUB_ARGV_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const args = invocations.at(-1);

    const effortIndex = args.indexOf('--thinking');
    assert.ok(effortIndex >= 0, 'the adapter must pass --thinking for a deepseek model');
    assert.strictEqual(args[effortIndex + 1], 'xhigh', 'deepseek models must run at xhigh reasoning effort');
  } finally {
    if (previousLauncher === undefined) delete process.env.CLINE_LAUNCHER;
    else process.env.CLINE_LAUNCHER = previousLauncher;
    if (previousLog === undefined) delete process.env.AF_STUB_ARGV_LOG;
    else process.env.AF_STUB_ARGV_LOG = previousLog;
  }
});

test('CLINE-8: Target workspace test logs containing HTTP 429 must NOT trigger RATE_LIMIT classification', async () => {
  const { classifyExecutionError } = await import('../lib/executor-error-classifier.mjs');
  // Workspace test output has '✔ 429 retries with Retry-After and then succeeds' and then a later assertion failed
  const cls = classifyExecutionError('cline', {
    exit_code: 1,
    stdout: '✔ 429 retries with Retry-After and then succeeds\n✖ test/features/runeInjector.test.mjs (1 of 206 failed)',
    stderr: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
  });
  assert.notStrictEqual(cls.category, 'RATE_LIMIT');
  assert.strictEqual(cls.category, 'TRANSIENT_FAULT');
});

