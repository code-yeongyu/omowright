const MAX_TIMER_MS = 2147483647;
const STOP = Symbol("wait stopped");

export type CaptchaWaitOutcome = "matched" | "cancelled" | "timed_out";

export interface CaptchaWaitResult {
  outcome: CaptchaWaitOutcome;
  elapsedMs: number;
}

/** Polled until it returns exactly `true`; `signal` aborts once the wait ends. */
export type CaptchaWaitPredicate<P> = (page: P, context: { signal: AbortSignal }) => unknown;

export interface CaptchaWaitOptions<P> {
  /** Required: waitForCaptcha throws a TypeError without it. */
  until?: CaptchaWaitPredicate<P> | undefined;
  timeoutMs?: number | undefined;
  pollMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export async function waitForCaptcha<P>(page: P, {
  until, timeoutMs = 10000, pollMs = 100, signal,
}: CaptchaWaitOptions<P> = {}): Promise<CaptchaWaitResult> {
  if (typeof until !== "function") throw new TypeError("until must be a function");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError("timeoutMs must be between 0 and 2147483647");
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0 || pollMs > MAX_TIMER_MS) {
    throw new RangeError("pollMs must be greater than 0 and at most 2147483647");
  }
  if (signal !== undefined && (typeof signal?.aborted !== "boolean"
    || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    throw new TypeError("signal must be AbortSignal-compatible");
  }

  const started = performance.now();
  const deadline = started + timeoutMs;
  const operation = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const { promise: stopped, resolve: resolveStopped } = Promise.withResolvers<typeof STOP>();
  const stop = () => resolveStopped(STOP);
  const terminal = (): CaptchaWaitOutcome | null => signal?.aborted ? "cancelled"
    : performance.now() >= deadline ? "timed_out" : null;
  const result = (outcome: CaptchaWaitOutcome): CaptchaWaitResult => ({ outcome, elapsedMs: performance.now() - started });
  const scheduleDeadline = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) stop();
    else deadlineTimer = setTimeout(scheduleDeadline, Math.ceil(remaining));
  };

  try {
    const initial = terminal();
    if (initial) return result(initial);
    signal?.addEventListener("abort", stop, { once: true });
    scheduleDeadline();
    // The first evaluation only yields to cancellation: a scheduling stall
    // between the call and this microtask must not time the wait out unevaluated.
    let evaluated = false;
    for (;;) {
      let accepted: unknown;
      try {
        // Promise.race keeps a rejection handler on a non-cooperative predicate
        // even after this wait has timed out or been cancelled.
        accepted = await Promise.race([
          Promise.resolve().then(() => (evaluated ? terminal() : signal?.aborted)
            ? STOP : until(page, { signal: operation.signal })),
          stopped,
        ]);
      } catch (error) {
        const outcome = terminal();
        if (outcome) return result(outcome);
        throw error;
      }
      evaluated = true;
      const outcome = terminal();
      if (outcome) return result(outcome);
      if (accepted === true) return result("matched");
      await Promise.race([
        new Promise(resolve => {
          pollTimer = setTimeout(resolve, Math.ceil(Math.min(pollMs, deadline - performance.now())));
        }),
        stopped,
      ]);
      clearTimeout(pollTimer);
      const afterDelay = terminal();
      if (afterDelay) return result(afterDelay);
    }
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
    signal?.removeEventListener("abort", stop);
    operation.abort();
    stop();
  }
}
