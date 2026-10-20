/**
 * A per-key save queue that keeps only the newest job.
 *
 * Autosave writes the whole project, so five transforms in a row used to mean
 * five full writes chained end to end -- four of which were already obsolete
 * before they started, because each one serializes the scene as it is now.
 * Superseding the waiting job instead means at most two writes: the one in
 * flight, and one more for wherever the scene ended up.
 *
 * Jobs for different keys do not wait for each other.
 */
export type CoalescingSaveQueue<Job> = {
  /** Run `job` for `key`, or replace whatever job is already waiting on it. */
  enqueue: (key: string, job: Job) => void;
  /** Whether a job for `key` is running or waiting. */
  isBusy: (key: string) => boolean;
  /** Resolves once nothing is running or waiting. For tests and for teardown. */
  idle: () => Promise<void>;
};

/** Whether another job for the same key was already waiting when this one ended. */
export type SaveOutcome = { waiting: boolean };

export function createCoalescingSaveQueue<Job>(options: {
  run: (key: string, job: Job) => Promise<void>;
  onSaved?: (key: string, job: Job, outcome: SaveOutcome) => void;
  onError?: (key: string, job: Job, error: unknown, outcome: SaveOutcome) => void;
  onSuperseded?: (key: string, job: Job) => void;
}): CoalescingSaveQueue<Job> {
  const waiting = new Map<string, { job: Job | null }>();
  const running = new Map<string, Promise<void>>();

  async function drain(key: string, first: Job) {
    let job: Job | null = first;
    while (job !== null) {
      let failure: unknown;
      let failed = false;
      try {
        await options.run(key, job);
      } catch (error) {
        failed = true;
        failure = error;
      }
      // Read what is waiting before reporting, so a caller can tell whether
      // this result is about to be replaced -- a failed write is not worth
      // telling anyone about if a newer one is already queued behind it.
      const slot = waiting.get(key);
      const next = slot?.job ?? null;
      if (slot) slot.job = null;
      const outcome = { waiting: next !== null };
      // A failed write must not discard the newest scene: report it and go on
      // to whatever arrived while this one was failing.
      if (failed) options.onError?.(key, job, failure, outcome);
      else options.onSaved?.(key, job, outcome);
      job = next;
    }
    waiting.delete(key);
    running.delete(key);
  }

  return {
    enqueue(key, job) {
      const slot = waiting.get(key);
      if (slot) {
        if (slot.job !== null) options.onSuperseded?.(key, slot.job);
        slot.job = job;
        return;
      }
      waiting.set(key, { job: null });
      running.set(key, drain(key, job));
    },
    isBusy(key) {
      return running.has(key);
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
}
