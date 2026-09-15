// executor-error-classifier.mjs - PHASE 5-A Executor Error Classification
//
// Pure functional classifier: maps raw process exit evidence (stdout, stderr,
// exit_code, timedOut, spawn_error) into structured safety and retry semantics.
// The Scheduler only reads `retryable` and never parses executor error strings.

export const ERROR_CATEGORIES = Object.freeze({
  ACCOUNT_POLICY: 'ACCOUNT_POLICY',
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH_FAILURE: 'AUTH_FAILURE',
  ENVIRONMENT_FAULT: 'ENVIRONMENT_FAULT',
  TRANSIENT_FAULT: 'TRANSIENT_FAULT',
  SUCCESS: 'SUCCESS',
});

export const SAFETY_ACTIONS = Object.freeze({
  OPEN_MANUAL_RESET: 'OPEN_MANUAL_RESET',
  COOLDOWN: 'COOLDOWN',
  NONE: 'NONE',
});

const PATTERNS = {
  ACCOUNT_POLICY: /403|TOS_VIOLATION|Terms of Service|ACCOUNT_DISABLED|account.*disabled|PERMISSION_DENIED/i,
  RATE_LIMIT: /429|ResourceExhausted|rate limit|quota exceeded|too many requests|daily.*(?:limit|quota)|limit.*reached/i,
  AUTH_FAILURE: /401|unauthorized|token expired|auth failed|invalid_token|authentication required/i,
  ENVIRONMENT_FAULT: /CWD_MISSING|ENOENT|binary missing|command not found|GOVERNANCE_DENIED|GOVERNANCE_ENV_REQUIRED|WRITE_CONFLICT|MAX_REVISIONS_EXCEEDED|TASK_ALREADY_RUNNING|SCHEDULER_AT_CAPACITY/i,
};

export function classifyExecutionError(executorType, {
  exit_code = 0,
  stdout = '',
  stderr = '',
  timedOut = false,
  spawn_error = null,
} = {}) {
  // If exit is clean and no timeout/spawn error
  if (exit_code === 0 && !timedOut && !spawn_error) {
    return {
      category: ERROR_CATEGORIES.SUCCESS,
      retryable: false,
      safety_action: SAFETY_ACTIONS.NONE,
      reason: null,
    };
  }

  if (timedOut) {
    return {
      category: ERROR_CATEGORIES.TRANSIENT_FAULT,
      retryable: true,
      safety_action: SAFETY_ACTIONS.NONE,
      reason: 'timeout',
    };
  }

  const errText = `${spawn_error || ''}\n${stderr || ''}`;
  const fullText = `${errText}\n${stdout || ''}`;
  const text = fullText;

  if (PATTERNS.ACCOUNT_POLICY.test(errText) || /(?:TOS_VIOLATION|Terms of Service|ACCOUNT_DISABLED|account.*disabled)/i.test(fullText)) {
    return {
      category: ERROR_CATEGORIES.ACCOUNT_POLICY,
      retryable: false,
      safety_action: SAFETY_ACTIONS.OPEN_MANUAL_RESET,
      reason: 'account or policy violation detected (403/TOS_VIOLATION)',
    };
  }

  // Rate limit: Check errText (stderr + spawn_error) first.
  // In stdout, only match if it is an explicit provider error and not a workspace test log.
  const isRateLimit = PATTERNS.RATE_LIMIT.test(errText)
    || (PATTERNS.RATE_LIMIT.test(fullText)
        && !/✔.*(?:429|rate\s*limit)|(?:test|tests|suite|pass|fail).*(?:429|rate\s*limit)/i.test(stdout)
        && /(?:provider|api|model|quota|rate\s*limit|resourceexhausted|daily.*limit)/i.test(fullText));

  if (isRateLimit) {
    return {
      category: ERROR_CATEGORIES.RATE_LIMIT,
      retryable: false,
      safety_action: SAFETY_ACTIONS.COOLDOWN,
      reason: 'rate limit or quota exceeded (429)',
    };
  }

  if (PATTERNS.AUTH_FAILURE.test(text)) {
    return {
      category: ERROR_CATEGORIES.AUTH_FAILURE,
      retryable: false,
      safety_action: SAFETY_ACTIONS.OPEN_MANUAL_RESET,
      reason: 'authentication failure or token expired (401)',
    };
  }

  if (PATTERNS.ENVIRONMENT_FAULT.test(text)) {
    return {
      category: ERROR_CATEGORIES.ENVIRONMENT_FAULT,
      retryable: false,
      safety_action: SAFETY_ACTIONS.NONE,
      reason: spawn_error || 'environment or binary fault',
    };
  }

  // Fallback: transient execution error (process crash, syntax failure, timeout, network glitch)
  return {
    category: ERROR_CATEGORIES.TRANSIENT_FAULT,
    retryable: true,
    safety_action: SAFETY_ACTIONS.NONE,
    reason: timedOut ? 'timeout' : (spawn_error || stderr || `exit ${exit_code}`),
  };
}
