// zcode-adapter.test.mjs - ZCode Executor Adapter & Router Integration tests
//
// Test Matrix:
//   ZCODE-1: ZcodeAdapter contract conforms to unified ExecutorResult interface
//   ZCODE-2: Health check verifies binary and governance
//   ZCODE-3: ROLE != PLATFORM: zcode can be routed as author or reviewer
//   ZCODE-4: Capability: requires_mcp retains zcode (supports unattended MCP)
//   ZCODE-5: Router Priority: priority_order and preference correctly select zcode

import { test } from 'node:test';
import assert from 'node:assert';
import './helpers/runtime-state-fixture.mjs';
import './helpers/executors-fixture.mjs';
import { ZcodeAdapter, ADAPTERS } from '../lib/adapters.mjs';
import { resolveExecutorRoute } from '../lib/executor-router.mjs';

test('ZCODE-1: ZcodeAdapter contract conforms to unified ExecutorResult interface', () => {
  assert.strictEqual(ZcodeAdapter.type, 'zcode');
  assert.strictEqual(ZcodeAdapter.supportsMcpUnattended, true);
  assert.strictEqual(ZcodeAdapter.exact_resume, true);
  assert.strictEqual(typeof ZcodeAdapter.run, 'function');
  assert.strictEqual(typeof ZcodeAdapter.resume, 'function');
  assert.strictEqual(typeof ZcodeAdapter.cancel, 'function');
  assert.strictEqual(typeof ZcodeAdapter.health, 'function');
  assert.strictEqual(ADAPTERS.zcode, ZcodeAdapter, 'ZcodeAdapter must be registered in ADAPTERS');
});

test('ZCODE-2: Health check verifies binary and governance', () => {
  const h = ZcodeAdapter.health();
  assert.strictEqual(h.executor_type, 'zcode');
  assert.ok(h.launcher.includes('zcode-af'), 'launcher must point to zcode-af');
  assert.strictEqual(h.ok, true, 'health must be ok when zcode binary/launcher is available');
});

test('ZCODE-3: ROLE != PLATFORM: zcode can be routed as author or reviewer', () => {
  const authorRoute = resolveExecutorRoute({ author_executor: 'zcode' }, { role: 'author' });
  assert.strictEqual(authorRoute.primary, 'zcode');

  const reviewerRoute = resolveExecutorRoute({ reviewer_executor: 'zcode' }, { role: 'reviewer' });
  assert.strictEqual(reviewerRoute.primary, 'zcode');
});

test('ZCODE-4: Capability: requires_mcp retains zcode (supports unattended MCP)', () => {
  const route = resolveExecutorRoute(
    { priority_order: ['zcode', 'claude'] },
    { requiresMcp: true }
  );
  assert.strictEqual(route.primary, 'zcode', 'zcode must be selected when requiresMcp is true');
});

test('ZCODE-5: Router Priority: priority_order and preference correctly select zcode', () => {
  const route = resolveExecutorRoute({
    priority_order: ['zcode', 'codex', 'claude'],
  });
  assert.strictEqual(route.primary, 'zcode');
  assert.ok(route.fallbacks.includes('claude'));
});
