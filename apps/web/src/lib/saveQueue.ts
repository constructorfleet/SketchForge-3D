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

export function createCoalescingSaveQueue<Job>(options: {
  run: (key: string, job: Job) => Promise<void>;
  onSaved?: (key: string, job: Job) => void;
  onError?: (key: string, job: Job, error: unknown) => void;
  onSuperseded?: (key: string, job: Job) => void;
}): CoalescingSaveQueue<Job> {
  const waiting = new Map<string, { job: Job | null }>();
  const running = new Map<string, Promise<void>>();

  async function drain(key: string, first: Job) {
    let job: Job | null = first;
    while (job !== null) {
      try {
        await options.run(key, job);
        options.onSaved?.(key, job);
      } catch (error) {
        // A failed write must not discard the newest scene: report it and go
        // on to whatever arrived while this one was failing.
        options.onError?.(key, job, error);
      }
      const slot = waiting.get(key);
      job = slot?.job ?? null;
      if (slot) slot.job = null;
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
