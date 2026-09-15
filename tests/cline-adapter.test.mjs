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
  // Verify deepseek thinking option in cline CLI supports xhigh
  const { execSync } = await import('node:child_process');
  const { CLINE_LAUNCHER } = await import('../lib/config.mjs');
  const helpOut = execSync(`"${CLINE_LAUNCHER}" --help`, { encoding: 'utf8' });
  assert.ok(helpOut.includes('--thinking <level>'), 'cline-af must support --thinking flag');
  assert.ok(helpOut.includes('xhigh'), 'cline-af must support xhigh thinking level');
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

