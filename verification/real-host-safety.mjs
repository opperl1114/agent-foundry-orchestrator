// real-host-safety.mjs - PHASE 5-C Real Host Safety Validation
//
// Validates the full calling chain on the real host:
//   Scheduler -> Orchestrator -> Adapter -> Runtime Guard -> OS Process Handle -> Error Classifier -> Safety State & Events
//
// Scenarios:
//   RHC-OPS-1: Real executor failure -> Circuit Open (no retry, records task_id, run_id, PID, event)
//   RHC-OPS-2: Circuit Isolation (agy OPEN does not block claude CLOSED)
//   RHC-OPS-3: Restart Persistence (cold boot reads OPEN_MANUAL_RESET, no auto-probe)
//   RHC-OPS-4: Operator Reset Safety (af-admin circuit reset with --reason, audit event, returns CLOSED)
//   RHC-OPS-5: Burst Protection Real Verification (10 concurrent requests, peak OS processes <= 1)
//
// Usage: node verification/real-host-safety.mjs

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Scheduler } from '../lib/scheduler.mjs';
import { runtimeGuard } from '../lib/executor-runtime-guard.mjs';
import { classifyExecutionError } from '../lib/executor-error-classifier.mjs';
import { saveTaskAtomic, readTaskFile } from '../lib/store.mjs';
import { readRuntimeAuditEvents } from '../lib/executor-ops.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_DIR = join(ROOT, 'tasks');
const RUNS_DIR = join(ROOT, 'runtime', 'runs');
const STATE_FILE = join(ROOT, 'runtime', 'executor-safety-state.json');
const EVENTS_FILE = join(ROOT, 'runtime', 'executor-runtime-events.jsonl');

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });

function makePreflightExecDir(dir) {
  const execDir = join(dir, 'executors');
  mkdirSync(execDir, { recursive: true });
  writeFileSync(join(execDir, 'claude.json'), JSON.stringify({
    executor_id: 'claude', capabilities_audit: { m1: 'PASS' }, blockers: [],
  }));
  writeFileSync(join(execDir, 'antigravity.json'), JSON.stringify({
    executor_id: 'antigravity', capabilities_audit: { m1: 'PASS' }, blockers: [],
  }));
  writeFileSync(join(execDir, 'codex.json'), JSON.stringify({
    executor_id: 'codex', capabilities_audit: { m1: 'PASS' }, blockers: [],
  }));
  return execDir;
}

// Helper to run a real OS child process through the full Runtime Safety & Adapter pipeline
async function runSubprocessWithSafety({ executorType, argv, capsule }) {
  const started = new Date().toISOString();
  const runId = capsule.runId || `RUN-${randomUUID().slice(0, 8)}`;

  await runtimeGuard.acquireSlot(executorType);

  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      runtimeGuard.releaseSlot(executorType);
    }
  };

  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: capsule.cwd || '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write durable handle (matches lib/adapters.mjs behavior)
    mkdirSync(RUNS_DIR, { recursive: true });
    writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify({
      run_id: runId,
      pid: child.pid,
      task_id: capsule.task_id ?? null,
      adapter_type: executorType,
      started_at: started,
    }, null, 2));

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('close', (code) => {
      releaseSlot();
      const finished = new Date().toISOString();
      const rawRes = { exit_code: code, stdout, stderr, timedOut: false, spawn_error: null };
      const classification = classifyExecutionError(executorType, rawRes);
      runtimeGuard.recordResult(executorType, classification);

      resolve({
        executor_run_id: runId,
        executor_type: executorType,
        assigned_role: capsule.assigned_role,
        status: code === 0 ? 'completed' : 'failed',
        session_ref: `S-${executorType}-${randomUUID().slice(0, 6)}`,
        structured_result: { result: stdout },
        exit_code: code,
        started_at: started,
        finished_at: finished,
        error: code === 0 ? null : (stderr || `exit ${code}`),
        error_classification: classification,
        pid: child.pid,
      });
    });

    child.on('error', (err) => {
      releaseSlot();
      const finished = new Date().toISOString();
      const rawRes = { exit_code: -1, stdout: '', stderr: err.message, timedOut: false, spawn_error: err.message };
      const classification = classifyExecutionError(executorType, rawRes);
      runtimeGuard.recordResult(executorType, classification);

      resolve({
        executor_run_id: runId,
        executor_type: executorType,
        assigned_role: capsule.assigned_role,
        status: 'failed',
        session_ref: null,
        structured_result: null,
        exit_code: -1,
        started_at: started,
        finished_at: finished,
        error: err.message,
        error_classification: classification,
        pid: child.pid,
      });
    });
  });
}

// ---------------------------------------------------------------- RHC-OPS-1
async function testRhcOps1() {
  console.log('\n============================================================');
  console.log('>>> [RHC-OPS-1] Real executor failure -> Circuit Open');
  console.log('============================================================');

  // Start with clean state for antigravity
  runtimeGuard.resetForTesting({
    circuits: { antigravity: { state: 'CLOSED', reason: null } },
  });

  const runTag = Date.now().toString(36);
  const taskId = `TASK-RHC-OPS-1-${runTag}`;
  let capturedRunId = null;
  let capturedPid = null;

  // Real adapter executing real OS child process that outputs 403 TOS violation
  const realFailingAdapter = {
    type: 'antigravity',
    supportsMcpUnattended: true,
    async run(capsule) {
      const runId = capsule.runId || `RUN-${randomUUID().slice(0, 8)}`;
      capturedRunId = runId;

      const args = [
        'node',
        '-e',
        'process.stderr.write("403 PERMISSION_DENIED: This service has been disabled in this account for violation of Terms of Service\\n"); process.exit(1);',
      ];
      const res = await runSubprocessWithSafety({
        executorType: 'antigravity',
        argv: args,
        capsule: { ...capsule, runId, task_id: taskId },
      });

      capturedPid = res.pid;
      return res;
    },
    cancel() { return { cancelled: true }; },
  };

  const tmpPreflightDir = mkdtempSync(join(tmpdir(), 'af-rhc1-pre-'));
  const execDir = makePreflightExecDir(tmpPreflightDir);

  const sched = new Scheduler({
    maxConcurrent: 2,
    maxExecutorRetries: 3, // scheduler configured with retries
    tasksDir: TASKS_DIR,
    executorStatusDir: execDir,
    runtimeGuard,
    adapters: {
      antigravity: realFailingAdapter,
      claude: { type: 'claude', run: async () => ({ status: 'completed' }) },
      codex: { type: 'codex', run: async () => ({ status: 'completed' }) },
    },
  });

  const taskObj = {
    task_id: taskId,
    goal: 'RHC-OPS-1 real failure circuit open test',
    acceptance: 'test acceptance',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: '/tmp',
    author_executor: 'antigravity',
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 2,
    red_lines: [],
    review_rules: [],
    state: 'CREATED',
    runs: [],
  };
  saveTaskAtomic(join(TASKS_DIR, `${taskId}.json`), taskObj);

  sched.enqueue(taskObj);
  sched.runNext();
  await sched.waitAll();

  // 1. Verify task result in task store
  const finalTask = readTaskFile(join(TASKS_DIR, `${taskId}.json`));
  const circuitState = runtimeGuard.getCircuitState('antigravity');

  // 2. Verify audit event
  const events = readRuntimeAuditEvents();
  const openEvent = events.filter((e) => e.event === 'CIRCUIT_OPEN' && e.executor === 'antigravity').pop();

  const evidence = {
    task_id: taskId,
    executor_run_id: capturedRunId,
    process_handle_pid: capturedPid,
    task_state: finalTask.state,
    task_retryable: finalTask.retryable,
    category: finalTask.error_classification?.category,
    runtime_circuit: circuitState.state,
    circuit_category: circuitState.category,
    scheduler_retries: finalTask.runs.filter((r) => r.purpose === 'author').length - 1,
    audit_event: openEvent,
  };

  console.log('RHC-OPS-1 Evidence:', JSON.stringify(evidence, null, 2));

  if (finalTask.state !== 'FAILED') throw new Error(`RHC-OPS-1 FAIL: task state expected FAILED, got ${finalTask.state}`);
  if (finalTask.retryable !== false) throw new Error(`RHC-OPS-1 FAIL: task retryable expected false, got ${finalTask.retryable}`);
  if (circuitState.state !== 'OPEN_MANUAL_RESET') throw new Error(`RHC-OPS-1 FAIL: circuit state expected OPEN_MANUAL_RESET, got ${circuitState.state}`);
  if (circuitState.category !== 'ACCOUNT_POLICY') throw new Error(`RHC-OPS-1 FAIL: circuit category expected ACCOUNT_POLICY, got ${circuitState.category}`);
  if (evidence.scheduler_retries !== 0) throw new Error(`RHC-OPS-1 FAIL: scheduler retried non-retryable failure (${evidence.scheduler_retries} retries)`);
  if (!openEvent) throw new Error('RHC-OPS-1 FAIL: CIRCUIT_OPEN event not found in audit log');

  console.log('>>> [RHC-OPS-1] PASS');
  return evidence;
}

// ---------------------------------------------------------------- RHC-OPS-2
async function testRhcOps2() {
  console.log('\n============================================================');
  console.log('>>> [RHC-OPS-2] Circuit Isolation (agy OPEN does not block claude)');
  console.log('============================================================');

  // Verify agy is currently OPEN_MANUAL_RESET
  const agyState = runtimeGuard.getCircuitState('antigravity');
  if (agyState.state !== 'OPEN_MANUAL_RESET') {
    throw new Error(`RHC-OPS-2 precondition failed: agy state is ${agyState.state}, expected OPEN_MANUAL_RESET`);
  }

  // Claude is CLOSED
  const claudeState = runtimeGuard.getCircuitState('claude');
  if (claudeState.state !== 'CLOSED') {
    runtimeGuard.resetCircuit('claude', { reset_by: 'test', reason: 'reset for test' });
  }

  const runTag = Date.now().toString(36);
  const taskId = `TASK-RHC-OPS-2-${runTag}`;
  const PASS_REVIEW = { decision: 'PASS', summary: 'all ok', issues: [], required_changes: [], evidence: ['file:1'] };

  // Claude adapter running real OS processes via runSubprocessWithSafety
  const realClaudeAdapter = {
    type: 'claude',
    supportsMcpUnattended: true,
    async run(capsule) {
      const runId = capsule.runId || `RUN-${randomUUID().slice(0, 8)}`;
      const isReview = capsule.assigned_role === 'reviewer';
      const outputText = isReview
        ? '```json\n' + JSON.stringify(PASS_REVIEW) + '\n```'
        : 'function add(a, b) { return a + b; }';

      const args = ['node', '-e', `process.stdout.write(${JSON.stringify(outputText)}); process.exit(0);`];
      return runSubprocessWithSafety({
        executorType: 'claude',
        argv: args,
        capsule: { ...capsule, runId, task_id: taskId },
      });
    },
    cancel() { return { cancelled: true }; },
  };

  const sched = new Scheduler({
    maxConcurrent: 2,
    tasksDir: TASKS_DIR,
    runtimeGuard,
    adapters: {
      antigravity: { type: 'antigravity', run: async () => { throw new Error('should not be called'); } },
      claude: realClaudeAdapter,
      codex: { type: 'codex', run: async () => ({ status: 'completed' }) },
    },
  });

  const taskObj = {
    task_id: taskId,
    goal: 'RHC-OPS-2 claude task isolation test',
    acceptance: 'test acceptance',
    acceptance_cmd: { command: 'node', args: ['-e', 'process.exit(0)'] },
    fixture_dir: '/tmp',
    author_executor: 'claude',
    reviewer_executor: 'claude',
    author_role: 'author',
    reviewer_role: 'reviewer',
    max_revisions: 2,
    red_lines: [],
    review_rules: [],
    state: 'CREATED',
    runs: [],
  };
  saveTaskAtomic(join(TASKS_DIR, `${taskId}.json`), taskObj);

  sched.enqueue(taskObj);
  sched.runNext();
  await sched.waitAll();

  const finalTask = readTaskFile(join(TASKS_DIR, `${taskId}.json`));
  const finalAgy = runtimeGuard.getCircuitState('antigravity');
  const finalClaude = runtimeGuard.getCircuitState('claude');

  const evidence = {
    task_id: taskId,
    task_state: finalTask.state,
    antigravity_state: finalAgy.state,
    claude_state: finalClaude.state,
    isolation_preserved: finalTask.state === 'COMPLETED' && finalAgy.state === 'OPEN_MANUAL_RESET',
  };

  console.log('RHC-OPS-2 Evidence:', JSON.stringify(evidence, null, 2));

  if (finalTask.state !== 'COMPLETED') throw new Error(`RHC-OPS-2 FAIL: task state expected COMPLETED, got ${finalTask.state}`);
  if (finalAgy.state !== 'OPEN_MANUAL_RESET') throw new Error(`RHC-OPS-2 FAIL: agy state corrupted, got ${finalAgy.state}`);
  if (finalClaude.state !== 'CLOSED') throw new Error(`RHC-OPS-2 FAIL: claude state expected CLOSED, got ${finalClaude.state}`);

  console.log('>>> [RHC-OPS-2] PASS');
  return evidence;
}

// ---------------------------------------------------------------- RHC-OPS-3
async function testRhcOps3() {
  console.log('\n============================================================');
  console.log('>>> [RHC-OPS-3] Restart Persistence (cold boot maintains OPEN_MANUAL_RESET)');
  console.log('============================================================');

  // Verify disk state has OPEN_MANUAL_RESET
  const diskStateBefore = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (diskStateBefore.antigravity?.state !== 'OPEN_MANUAL_RESET') {
    throw new Error('RHC-OPS-3 precondition failed: state file does not have antigravity in OPEN_MANUAL_RESET');
  }

  // Execute independent CLI subprocess: af-admin executor status antigravity
  const rawOutput = sh('af-admin executor status antigravity');
  console.log('Subprocess CLI Output:\n', rawOutput);

  if (!rawOutput.includes('executor:\nantigravity')) throw new Error('RHC-OPS-3 FAIL: missing executor: antigravity');
  if (!rawOutput.includes('capability:\nREADY')) throw new Error('RHC-OPS-3 FAIL: missing capability: READY');
  if (!rawOutput.includes('availability:\nACCOUNT_DISABLED_403')) throw new Error('RHC-OPS-3 FAIL: missing availability: ACCOUNT_DISABLED_403');
  if (!rawOutput.includes('runtime:\nOPEN_MANUAL_RESET')) throw new Error('RHC-OPS-3 FAIL: missing runtime: OPEN_MANUAL_RESET');
  if (!rawOutput.includes('circuit:\nOPEN')) throw new Error('RHC-OPS-3 FAIL: missing circuit: OPEN');
  if (!rawOutput.includes('last_failure:\nACCOUNT_POLICY')) throw new Error('RHC-OPS-3 FAIL: missing last_failure: ACCOUNT_POLICY');
  if (!rawOutput.includes('reset_required:\ntrue')) throw new Error('RHC-OPS-3 FAIL: missing reset_required: true');

  const evidence = {
    cli_invocation: 'af-admin executor status antigravity',
    output: rawOutput.trim(),
    restart_persistent: true,
  };

  console.log('>>> [RHC-OPS-3] PASS');
  return evidence;
}

// ---------------------------------------------------------------- RHC-OPS-4
async function testRhcOps4() {
  console.log('\n============================================================');
  console.log('>>> [RHC-OPS-4] Operator Reset Safety (af-admin circuit reset + audit evidence)');
  console.log('============================================================');

  // 1. Run reset CLI with reason
  const resetOutput = sh('af-admin circuit reset antigravity --reason "manual verification"');
  console.log('Reset CLI Output:\n', resetOutput);

  if (!resetOutput.includes('Circuit reset successful:')) throw new Error('RHC-OPS-4 FAIL: reset did not report success');
  if (!resetOutput.includes('state: CLOSED')) throw new Error('RHC-OPS-4 FAIL: state not CLOSED');
  if (!resetOutput.includes('reason: manual verification')) throw new Error('RHC-OPS-4 FAIL: reason missing in output');

  // 2. Verify audit event in runtime/executor-runtime-events.jsonl
  const events = readRuntimeAuditEvents();
  const resetEvent = events.filter((e) => e.event === 'CIRCUIT_RESET' && e.executor === 'antigravity').pop();
  if (!resetEvent) throw new Error('RHC-OPS-4 FAIL: CIRCUIT_RESET event not found in audit log');
  if (resetEvent.reason !== 'manual verification') throw new Error(`RHC-OPS-4 FAIL: unexpected event reason: ${resetEvent.reason}`);

  // 3. Query status again via CLI
  const statusOutput = sh('af-admin executor status antigravity');
  console.log('Status After Reset:\n', statusOutput);

  if (!statusOutput.includes('runtime:\nCLOSED')) throw new Error('RHC-OPS-4 FAIL: runtime is not CLOSED after reset');
  if (!statusOutput.includes('circuit:\nCLOSED')) throw new Error('RHC-OPS-4 FAIL: circuit is not CLOSED after reset');
  if (!statusOutput.includes('reset_required:\nfalse')) throw new Error('RHC-OPS-4 FAIL: reset_required is not false');

  const evidence = {
    reset_output: resetOutput.trim(),
    audit_event: resetEvent,
    status_after_reset: statusOutput.trim(),
  };

  console.log('>>> [RHC-OPS-4] PASS');
  return evidence;
}

// ---------------------------------------------------------------- RHC-OPS-5
async function testRhcOps5() {
  console.log('\n============================================================');
  console.log('>>> [RHC-OPS-5] Burst Protection Real Verification (10 concurrent requests)');
  console.log('============================================================');

  // In RHC-OPS-4, antigravity was reset to CLOSED via subprocess.
  // Sync the in-memory runtimeGuard instance to CLOSED as well:
  runtimeGuard.resetCircuit('antigravity', { reset_by: 'relaret', reason: 'manual verification' });

  // Now launch 10 concurrent requests on the real host to antigravity with max_parallel = 1.
  let activeProcesses = 0;
  let maxObservedActive = 0;
  const processPids = [];
  const TOTAL_TASKS = 10;
  const TASK_DURATION_MS = 30;

  async function runConcurrentRealTask(idx) {
    // Acquire slot via runtime guard
    await runtimeGuard.acquireSlot('antigravity');
    try {
      activeProcesses += 1;
      if (activeProcesses > maxObservedActive) {
        maxObservedActive = activeProcesses;
      }
      if (activeProcesses > 1) {
        throw new Error(`BURST VIOLATION: active concurrent processes (${activeProcesses}) > max_parallel (1)`);
      }

      // Spawns a real OS child process holding for TASK_DURATION_MS
      const runId = `RUN-BURST-${idx}-${randomUUID().slice(0, 6)}`;
      const child = spawn('node', ['-e', `setTimeout(() => process.exit(0), ${TASK_DURATION_MS});`], {
        cwd: '/tmp',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      processPids.push(child.pid);

      await new Promise((res) => {
        child.on('close', res);
      });

    } finally {
      activeProcesses -= 1;
      runtimeGuard.releaseSlot('antigravity');
    }
  }

  const startTime = Date.now();
  // Fire all 10 simultaneously
  await Promise.all(Array.from({ length: TOTAL_TASKS }, (_, i) => runConcurrentRealTask(i)));
  const totalElapsed = Date.now() - startTime;

  const evidence = {
    total_concurrent_requests: TOTAL_TASKS,
    configured_max_parallel: 1,
    max_observed_active_processes: maxObservedActive,
    total_spawned_pids: processPids.length,
    elapsed_time_ms: totalElapsed,
    serialized_minimum_expected_ms: TOTAL_TASKS * TASK_DURATION_MS * 0.8,
    burst_protected: maxObservedActive <= 1 && totalElapsed >= (TOTAL_TASKS * TASK_DURATION_MS * 0.8),
  };

  console.log('RHC-OPS-5 Evidence:', JSON.stringify(evidence, null, 2));

  if (maxObservedActive > 1) throw new Error(`RHC-OPS-5 FAIL: peak active processes was ${maxObservedActive}, expected <= 1`);
  if (!evidence.burst_protected) throw new Error('RHC-OPS-5 FAIL: elapsed time indicates tasks were not serialized');

  console.log('>>> [RHC-OPS-5] PASS');

  // Finally restore antigravity baseline state to OPEN_MANUAL_RESET
  writeFileSync(STATE_FILE, JSON.stringify({
    antigravity: {
      state: 'OPEN_MANUAL_RESET',
      category: 'ACCOUNT_POLICY',
      reason: 'TOS_VIOLATION',
      opened_at: '2026-09-05T00:00:00.000Z',
    },
  }, null, 2));

  return evidence;
}

// ---------------------------------------------------------------- Main runner
async function main() {
  console.log('============================================================');
  console.log('STARTING PHASE 5-C REAL HOST SAFETY VALIDATION');
  console.log('============================================================');

  const res1 = await testRhcOps1();
  const res2 = await testRhcOps2();
  const res3 = await testRhcOps3();
  const res4 = await testRhcOps4();
  const res5 = await testRhcOps5();

  console.log('\n============================================================');
  console.log('ALL 5 REAL HOST SAFETY VALIDATIONS PASSED');
  console.log('============================================================');

  return { res1, res2, res3, res4, res5 };
}

main().catch((err) => {
  console.error('\n!!! REAL HOST SAFETY VALIDATION FAILED !!!\n', err);
  process.exit(1);
});
