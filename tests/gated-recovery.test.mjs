// gated-recovery.test.mjs - PHASE 6-B Gated Executor Recovery tests
//
// Tests:
//   6B-1: healthy executor probe rejected (CLOSED -> probe rejected)
//   6B-2: OPEN_MANUAL_RESET -> PROBING (locks out production, permits recovery_probe)
//   6B-3: probe 403 -> reverts to OPEN_MANUAL_RESET (failure evidence recorded)
//   6B-4: probe success -> transitions to HALF_OPEN with verifiable evidence_id
//   6B-5: forged evidence rejected (mismatched evidence_id cannot admit)
//   6B-6: admit without reason rejected (reason is mandatory)
//   6B-7: valid admit -> CLOSED (state cleared, production tasks unblocked)
//   6B-8: zero automatic probing invariant (no auto-reset, no background probing)

import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';
import {
  executeRecoveryProbe,
  admitRecoveredExecutor,
  readRuntimeAuditEvents,
} from '../lib/executor-ops.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('6B-1: healthy executor probe rejected', async () => {
  const dir = tmpDir('af-6b-1-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  const guard = new ExecutorRuntimeGuard({ stateFile, policyFile, eventsLogFile });

  // claude starts in CLOSED by default
  assert.strictEqual(guard.getCircuitState('claude').state, 'CLOSED');

  await assert.rejects(
    async () => {
      await executeRecoveryProbe('claude', { runtimeGuard: guard });
    },
    /PROBE_REJECTED.*already healthy\/CLOSED/,
    'probe on healthy/CLOSED executor must be rejected'
  );

  rmSync(dir, { recursive: true, force: true });
});

test('6B-2: OPEN_MANUAL_RESET -> PROBING (locks out production, permits recovery_probe)', async () => {
  const dir = tmpDir('af-6b-2-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      category: 'ACCOUNT_POLICY',
      reason: '403 TOS_VIOLATION',
      opened_at: new Date().toISOString(),
    },
  }));

  const guard = new ExecutorRuntimeGuard({ stateFile, policyFile, eventsLogFile });
  assert.strictEqual(guard.getCircuitState('antigravity').state, 'OPEN_MANUAL_RESET');

  // Start probe
  const probeInfo = guard.startProbe('antigravity');
  assert.strictEqual(probeInfo.state, 'PROBING');
  assert.strictEqual(guard.getCircuitState('antigravity').state, 'PROBING');

  // Boundary check: production is blocked, but recovery_probe is allowed
  assert.strictEqual(guard.canExecute('antigravity', 'production'), false, 'production must be blocked during PROBING');
  assert.strictEqual(guard.canExecute('antigravity', 'recovery_probe'), true, 'recovery_probe must be allowed during PROBING');

  // Second probe must be rejected while already PROBING
  assert.throws(
    () => guard.startProbe('antigravity'),
    /PROBE_ALREADY_IN_PROGRESS/,
    'concurrent probe must be rejected'
  );

  rmSync(dir, { recursive: true, force: true });
});

test('6B-3: probe 403 -> reverts to OPEN_MANUAL_RESET', async () => {
  const dir = tmpDir('af-6b-3-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      category: 'ACCOUNT_POLICY',
      reason: '403 TOS_VIOLATION',
      opened_at: new Date().toISOString(),
    },
  }));

  const guard = new ExecutorRuntimeGuard({ stateFile, policyFile, eventsLogFile });

  // Mock failing adapter (simulating persistent 403 on appeal not yet settled)
  const failingAdapter = {
    type: 'antigravity',
    run: async () => ({
      executor_run_id: 'RUN-PROBE-FAIL-1',
      executor_type: 'antigravity',
      assigned_role: 'verifier',
      status: 'failed',
      exit_code: 1,
      error: '403 Forbidden: TOS_VIOLATION (account disabled)',
      structured_result: null,
      finished_at: new Date().toISOString(),
    }),
  };

  const probeRes = await executeRecoveryProbe('antigravity', {
    runtimeGuard: guard,
    adapters: { antigravity: failingAdapter },
  });

  assert.strictEqual(probeRes.success, false);
  assert.strictEqual(probeRes.state, 'OPEN_MANUAL_RESET');
  assert.strictEqual(guard.getCircuitState('antigravity').state, 'OPEN_MANUAL_RESET');
  assert.strictEqual(probeRes.category, 'ACCOUNT_POLICY');

  // Verify audit events recorded PROBE_STARTED and PROBE_FAILED
  const events = readRuntimeAuditEvents({ eventsLogFile });
  assert.ok(events.some((e) => e.event === 'PROBE_STARTED' && e.executor === 'antigravity'));
  assert.ok(events.some((e) => e.event === 'PROBE_FAILED' && e.executor === 'antigravity' && e.category === 'ACCOUNT_POLICY'));

  rmSync(dir, { recursive: true, force: true });
});

test('6B-4: probe success -> transitions to HALF_OPEN with verifiable evidence_id', async () => {
  const dir = tmpDir('af-6b-4-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      category: 'ACCOUNT_POLICY',
      reason: '403 TOS_VIOLATION',
      opened_at: new Date().toISOString(),
    },
  }));

  const guard = new ExecutorRuntimeGuard({ stateFile, policyFile, eventsLogFile });

  // Mock successful adapter (appeal succeeded, probe ping passes)
  const successAdapter = {
    type: 'antigravity',
    run: async (capsule) => {
      // Must be running in an isolated sandbox directory
      assert.ok(capsule.cwd && capsule.cwd.includes('af-recovery-probe-'));
      assert.strictEqual(capsule.purpose, 'recovery_probe');
      return {
        executor_run_id: 'RUN-PROBE-PASS-1',
        executor_type: 'antigravity',
        assigned_role: 'verifier',
        status: 'completed',
        exit_code: 0,
        error: null,
        structured_result: { result: 'AGENT_FOUNDRY_PROBE_OK' },
        finished_at: new Date().toISOString(),
      };
    },
  };

  const probeRes = await executeRecoveryProbe('antigravity', {
    runtimeGuard: guard,
    adapters: { antigravity: successAdapter },
  });

  assert.strictEqual(probeRes.success, true);
  assert.strictEqual(probeRes.state, 'HALF_OPEN');
  assert.ok(typeof probeRes.evidence_id === 'string' && probeRes.evidence_id.startsWith('PEVT-'));

  const circuitState = guard.getCircuitState('antigravity');
  assert.strictEqual(circuitState.state, 'HALF_OPEN');
  assert.strictEqual(circuitState.probe_evidence_id, probeRes.evidence_id);

  // In HALF_OPEN, production tasks remain blocked until operator admit
  assert.strictEqual(guard.canExecute('antigravity', 'production'), false);

  const events = readRuntimeAuditEvents({ eventsLogFile });
  assert.ok(events.some((e) => e.event === 'PROBE_VERIFIED' && e.evidence_id === probeRes.evidence_id));

  rmSync(dir, { recursive: true, force: true });
});

test('6B-5: forged evidence rejected', async () => {
  const dir = tmpDir('af-6b-5-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  const validEvidenceId = 'PEVT-valid-12345';
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'HALF_OPEN',
      probe_evidence_id: validEvidenceId,
      opened_at: new Date().toISOString(),
    },
  }));

  const guard = new ExecutorRuntimeGuard({ stateFile, policyFile, eventsLogFile });

  // Attempt admit with forged evidence
  assert.throws(
    () => {
      admitRecoveredExecutor('antigravity', {
        evidence_id: 'PEVT-forged-99999',
        reason: 'Attempted bypass with fake evidence',
        runtimeGuard: guard,
      });
    },
    /ADMISSION_REJECTED: evidence_id mismatch/,
    'mismatched evidence must be rejected'
  );

  // State must remain HALF_OPEN
  assert.strictEqual(guard.getCircuitState('antigravity').state, 'HALF_OPEN');

  rmSync(dir, { recursive: true, force: true });
});

test('6B-6: admit without reason rejected', async () => {
  const dir = tmpDir('af-6b-6-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  const evidenceId = 'PEVT-evidence-6666';
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'HALF_OPEN',
      probe_evidence_id: evidenceId,
      opened_at: new Date().toISOString(),
    },
  }));

  const guard = new ExecutorRuntimeGuard({ stateFile, policyFile, eventsLogFile });

  // Missing reason
  assert.throws(
    () => {
      admitRecoveredExecutor('antigravity', {
        evidence_id: evidenceId,
        reason: '',
        runtimeGuard: guard,
      });
    },
    /ADMISSION_REJECTED: reason is required/
  );

  // Missing evidence
  assert.throws(
    () => {
      admitRecoveredExecutor('antigravity', {
        evidence_id: '',
        reason: 'Valid reason without evidence',
        runtimeGuard: guard,
      });
    },
    /ADMISSION_REJECTED: evidence_id is required/
  );

  assert.strictEqual(guard.getCircuitState('antigravity').state, 'HALF_OPEN');

  rmSync(dir, { recursive: true, force: true });
});

test('6B-7: valid admit -> CLOSED (state cleared, production tasks unblocked)', async () => {
  const dir = tmpDir('af-6b-7-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  const evidenceId = 'PEVT-audit-pass-777';
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'HALF_OPEN',
      probe_evidence_id: evidenceId,
      opened_at: new Date().toISOString(),
    },
  }));

  const guard = new ExecutorRuntimeGuard({ stateFile, policyFile, eventsLogFile });

  const admitRes = admitRecoveredExecutor('antigravity', {
    evidence_id: evidenceId,
    reason: 'Google Support confirmed ToS appeal approved; sandbox probe passed',
    admitted_by: 'lead-operator',
    runtimeGuard: guard,
  });

  assert.strictEqual(admitRes.state, 'CLOSED');
  assert.strictEqual(admitRes.admitted_by, 'lead-operator');
  assert.strictEqual(admitRes.evidence_id, evidenceId);

  // State in guard is now CLOSED
  const finalState = guard.getCircuitState('antigravity');
  assert.strictEqual(finalState.state, 'CLOSED');
  assert.strictEqual(finalState.probe_evidence_id, null);
  assert.strictEqual(finalState.last_reset?.reset_by, 'lead-operator');

  // Production tasks are now unblocked
  assert.strictEqual(guard.canExecute('antigravity', 'production'), true);

  // Audit log contains RECOVERY_ADMITTED event
  const events = readRuntimeAuditEvents({ eventsLogFile });
  assert.ok(events.some((e) => e.event === 'RECOVERY_ADMITTED' && e.admitted_by === 'lead-operator' && e.evidence_id === evidenceId));

  rmSync(dir, { recursive: true, force: true });
});

test('6B-8: zero automatic probing invariant', async () => {
  const dir = tmpDir('af-6b-8-');
  const stateFile = join(dir, 'executor-safety-state.json');
  const policyFile = join(dir, 'executor-safety-policy.json');
  const eventsLogFile = join(dir, 'executor-runtime-events.jsonl');

  let mockProbeCalls = 0;
  writeFileSync(stateFile, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      category: 'ACCOUNT_POLICY',
      reason: '403 TOS_VIOLATION',
      opened_at: new Date().toISOString(),
    },
  }));

  let simulatedNow = Date.now();
  const guard = new ExecutorRuntimeGuard({
    stateFile,
    policyFile,
    eventsLogFile,
    now: () => simulatedNow,
  });

  // Advance time by 30 days
  simulatedNow += 30 * 24 * 3600 * 1000;

  // Query circuit state multiple times
  for (let i = 0; i < 20; i++) {
    const c = guard.getCircuitState('antigravity');
    assert.strictEqual(c.state, 'OPEN_MANUAL_RESET', 'state must never auto-recover');
    assert.strictEqual(guard.canExecute('antigravity', 'production'), false);
  }

  // Probe calls remain 0
  assert.strictEqual(mockProbeCalls, 0, 'zero automated probing must occur');

  rmSync(dir, { recursive: true, force: true });
});
