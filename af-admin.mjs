#!/usr/bin/env node

// af-admin.mjs - PHASE 5-B Executor Operations CLI
import {
  getExecutorOperationsStatus,
  formatExecutorStatus,
  listCircuitBreakers,
  formatCircuitList,
  resetCircuitBreaker,
  executeRecoveryProbe,
  admitRecoveredExecutor,
  formatRecoveryProbeResult,
  formatAdmissionResult,
  pruneTasks,
  formatTasksPruneResult,
  rotateLogs,
  formatLogRotationResult,
} from './lib/executor-ops.mjs';

const args = process.argv.slice(2);
const mainCmd = args[0];
const subCmd = args[1];

function argValue(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

function printUsage() {
  console.log(`usage:
  af-admin executor status [executor]
  af-admin executor recovery probe <executor>
  af-admin executor recovery admit <executor> --evidence <id> --reason "<reason>" [--admitted-by "<name>"]
  af-admin circuit list
  af-admin circuit reset <executor> --reason "<reason>" [--reset-by "<name>"]
  af-admin tasks prune [--confirm] [--tasks-dir <path>]
  af-admin logs rotate [--days <N>] [--events-file <path>] [--archive-dir <path>]`);
}

async function main() {
  if (!mainCmd || mainCmd === '--help' || mainCmd === '-h' || mainCmd === 'help') {
    printUsage();
    process.exit(0);
  }

  if (mainCmd === 'executor') {
    if (subCmd === 'status') {
      const target = args[2] && !args[2].startsWith('-') ? args[2] : argValue('--executor');
      if (target) {
        try {
          const status = getExecutorOperationsStatus(target);
          console.log(formatExecutorStatus(status));
          process.exit(0);
        } catch (err) {
          console.error(`error: ${err.message}`);
          process.exit(1);
        }
      } else {
        const list = listCircuitBreakers();
        const formatted = list.map((item) => {
          const status = getExecutorOperationsStatus(item.id);
          return formatExecutorStatus(status);
        }).join('\n\n---\n\n');
        console.log(formatted);
        process.exit(0);
      }
    } else if (subCmd === 'recovery') {
      const action = args[2];
      if (action === 'probe') {
        const target = args[3] && !args[3].startsWith('-') ? args[3] : argValue('--executor');
        if (!target) {
          console.error('error: executor is required: af-admin executor recovery probe <executor>');
          process.exit(1);
        }
        try {
          const res = await executeRecoveryProbe(target);
          console.log(formatRecoveryProbeResult(res));
          process.exit(res.success ? 0 : 1);
        } catch (err) {
          console.error(`error: ${err.message}`);
          process.exit(1);
        }
      } else if (action === 'admit') {
        const target = args[3] && !args[3].startsWith('-') ? args[3] : argValue('--executor');
        const evidence = argValue('--evidence');
        const reason = argValue('--reason');
        const admittedBy = argValue('--admitted-by') || process.env.USER || 'operator';

        if (!target) {
          console.error('error: executor is required: af-admin executor recovery admit <executor> --evidence <id> --reason "<reason>"');
          process.exit(1);
        }
        if (!evidence || !evidence.trim()) {
          console.error('error: --evidence is required for recovery admission');
          process.exit(1);
        }
        if (!reason || !reason.trim()) {
          console.error('error: --reason is required for recovery admission');
          process.exit(1);
        }

        try {
          const res = admitRecoveredExecutor(target, {
            evidence_id: evidence.trim(),
            reason: reason.trim(),
            admitted_by: admittedBy,
          });
          console.log(formatAdmissionResult(res));
          process.exit(0);
        } catch (err) {
          console.error(`error: ${err.message}`);
          process.exit(1);
        }
      } else {
        console.error(`unknown recovery action: ${action} (expected: probe | admit)`);
        printUsage();
        process.exit(1);
      }
    } else {
      console.error(`unknown executor subcommand: ${subCmd}`);
      printUsage();
      process.exit(1);
    }
  } else if (mainCmd === 'circuit') {
    if (subCmd === 'list') {
      const list = listCircuitBreakers();
      console.log(formatCircuitList(list));
      process.exit(0);
    } else if (subCmd === 'reset') {
      const target = args[2] && !args[2].startsWith('-') ? args[2] : argValue('--executor');
      const reason = argValue('--reason');
      const resetBy = argValue('--reset-by') || process.env.USER || 'operator';

      if (!target) {
        console.error('error: executor is required: af-admin circuit reset <executor> --reason "<reason>"');
        process.exit(1);
      }
      if (!reason || !reason.trim()) {
        console.error('error: --reason is required for manual circuit reset');
        process.exit(1);
      }

      try {
        const res = resetCircuitBreaker(target, { reason, reset_by: resetBy });
        console.log(`Circuit reset successful:`);
        console.log(`executor: ${res.executorType}`);
        console.log(`state: ${res.state}`);
        console.log(`reset_by: ${res.reset_by}`);
        console.log(`reset_time: ${res.reset_time}`);
        console.log(`reason: ${res.reason}`);
        process.exit(0);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`unknown circuit subcommand: ${subCmd}`);
      printUsage();
      process.exit(1);
    }
  } else if (mainCmd === 'tasks') {
    if (subCmd === 'prune') {
      const confirm = args.includes('--confirm');
      const tasksDir = argValue('--tasks-dir') || undefined;
      try {
        const res = pruneTasks({ tasksDir, confirm });
        console.log(formatTasksPruneResult(res));
        process.exit(0);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`unknown tasks subcommand: ${subCmd} (expected: prune)`);
      printUsage();
      process.exit(1);
    }
  } else if (mainCmd === 'logs') {
    if (subCmd === 'rotate') {
      const daysArg = argValue('--days');
      const days = daysArg ? parseInt(daysArg, 10) : 7;
      const eventsLogFile = argValue('--events-file') || undefined;
      const archiveDir = argValue('--archive-dir') || undefined;
      try {
        const res = rotateLogs({ eventsLogFile, archiveDir, days });
        console.log(formatLogRotationResult(res));
        process.exit(0);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`unknown logs subcommand: ${subCmd} (expected: rotate)`);
      printUsage();
      process.exit(1);
    }
  } else {
    console.error(`unknown command: ${mainCmd}`);
    printUsage();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
