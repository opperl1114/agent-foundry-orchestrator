// reviews.mjs - PHASE 3 review anti-cross-talk binding
//
// A ReviewerResult may only be applied to a task lifecycle when it is bound
// to the exact (task_id, revision, reviewed_executor_run_id) triple it was
// produced for. The reviewer result additionally echoes task_id/revision;
// when the echo disagrees, the result is rejected outright. This makes it
// structurally impossible to feed TASK-A's review into TASK-B: any stale or
// mismatched result is refused with STALE_OR_MISMATCHED_REVIEW before it can
// enter the fix loop.

export const REVIEW_BINDING_ERROR = 'STALE_OR_MISMATCHED_REVIEW';

export class ReviewMismatchError extends Error {
  constructor(detail) {
    super(`${REVIEW_BINDING_ERROR}: ${detail}`);
    this.code = REVIEW_BINDING_ERROR;
  }
}

// The author/fix run whose content is currently under review.
export function latestAuthorRun(task) {
  return [...(task.runs ?? [])].reverse().find((r) => r.purpose === 'author' || r.purpose === 'fix') ?? null;
}

// Validate a bound review against the expected triple.
export function validateReviewBinding(review, expected) {
  if (!review || typeof review !== 'object') throw new ReviewMismatchError('review result missing');
  if (review.task_id !== expected.task_id) {
    throw new ReviewMismatchError(`result is bound to task ${JSON.stringify(review.task_id)}, current task is ${JSON.stringify(expected.task_id)}`);
  }
  if (Number(review.revision) !== Number(expected.revision)) {
    throw new ReviewMismatchError(`result is bound to revision ${review.revision}, current revision is ${expected.revision}`);
  }
  if (expected.reviewed_executor_run_id && review.reviewed_executor_run_id !== expected.reviewed_executor_run_id) {
    throw new ReviewMismatchError(`result reviews run ${review.reviewed_executor_run_id}, but the run under review is ${expected.reviewed_executor_run_id}`);
  }
  const echo = review.reviewer_echo ?? {};
  if (echo.task_id && echo.task_id !== expected.task_id) {
    throw new ReviewMismatchError(`reviewer echoed task ${JSON.stringify(echo.task_id)} but was reviewing ${JSON.stringify(expected.task_id)} (cross-talk)`);
  }
  if (echo.revision != null && Number(echo.revision) !== Number(expected.revision)) {
    throw new ReviewMismatchError(`reviewer echoed revision ${echo.revision} but was reviewing ${expected.revision} (stale result)`);
  }
  return true;
}

// Stamp the binding onto a reviewer result and validate it before it may be
// applied. echo = the reviewer's echoed {task_id, revision} (may be null for
// legacy reviewers); a PRESENT but wrong echo is a hard reject.
export function bindReviewResult(task, revision, reviewedRun, review, echo = {}) {
  const bound = {
    ...review,
    task_id: task.task_id,
    revision,
    reviewed_executor_run_id: reviewedRun?.executor_run_id ?? null,
    reviewer_echo: { task_id: echo.task_id ?? null, revision: echo.revision ?? null },
  };
  validateReviewBinding(bound, {
    task_id: task.task_id,
    revision,
    reviewed_executor_run_id: bound.reviewed_executor_run_id,
  });
  return bound;
}
