/**
 * Retry schedule: exponential backoff over a 24-hour window that starts at the first attempt
 * (or at a replay). Each retry waits as long as the window has already run, at least 30 seconds
 * and at most 12 hours (the longest delay Queues accepts), so delays double: 30 s, 30 s, 1 min,
 * 2 min, 4 min ... 12 h. The last retry lands at the end of the window; a failure after that
 * dead-letters the delivery. Working from elapsed time rather than a count keeps the schedule
 * right after a replay without resetting the attempt counter.
 */
export const RETRY_WINDOW_SECONDS = 86_400;
export const FIRST_DELAY_SECONDS = 30;
export const MAX_DELAY_SECONDS = 43_200;

/** Seconds until the next attempt, or null when the window is spent. */
export function nextDelay(windowStart: number, now: number): number | null {
  const left = windowStart + RETRY_WINDOW_SECONDS - now;
  if (left <= 0) return null;
  const backoff = Math.min(Math.max(FIRST_DELAY_SECONDS, now - windowStart), MAX_DELAY_SECONDS);
  return Math.max(1, Math.min(backoff, left));
}

/** Only these answers count as delivered. Redirects are not followed. */
export const delivered = (status: number) => status >= 200 && status < 300;
