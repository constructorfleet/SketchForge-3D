import { describe, expect, it } from "vitest";
import { createCoalescingSaveQueue } from "@/lib/saveQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

describe("createCoalescingSaveQueue", () => {
  it("replaces the waiting job instead of queueing every one", async () => {
    const gates = [deferred(), deferred()];
    const ran: string[] = [];
    const saved: string[] = [];
    const superseded: string[] = [];
    const queue = createCoalescingSaveQueue<string>({
      run: (_key, job) => {
        ran.push(job);
        return gates[ran.length - 1].promise;
      },
      onSaved: (_key, job) => void saved.push(job),
      onSuperseded: (_key, job) => void superseded.push(job),
    });

    queue.enqueue("project", "first");
    queue.enqueue("project", "second");
    queue.enqueue("project", "third");
    queue.enqueue("project", "fourth");
    expect(ran).toEqual(["first"]);

    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    gates[1].resolve();
    await queue.idle();

    // "second" and "third" were obsolete before they could start.
    expect(ran).toEqual(["first", "fourth"]);
    expect(saved).toEqual(["first", "fourth"]);
    expect(superseded).toEqual(["second", "third"]);
  });

  it("does not make one project's save wait for another's", async () => {
    const gates = new Map([["a", deferred()], ["b", deferred()]]);
    const ran: string[] = [];
    const queue = createCoalescingSaveQueue<string>({
      run: (key) => {
        ran.push(key);
        return gates.get(key)!.promise;
      },
    });

    queue.enqueue("a", "a1");
    queue.enqueue("b", "b1");
    expect(ran).toEqual(["a", "b"]);
    expect(queue.isBusy("a")).toBe(true);
    expect(queue.isBusy("b")).toBe(true);

    gates.get("a")!.resolve();
    gates.get("b")!.resolve();
    await queue.idle();
    expect(queue.isBusy("a")).toBe(false);
  });

  it("reports a failed save and still writes the scene that arrived during it", async () => {
    const gates = [deferred(), deferred()];
    const ran: string[] = [];
    const saved: string[] = [];
    const errors: Array<{ job: string; error: unknown }> = [];
    const queue = createCoalescingSaveQueue<string>({
      run: (_key, job) => {
        ran.push(job);
        return gates[ran.length - 1].promise;
      },
      onSaved: (_key, job) => void saved.push(job),
      onError: (_key, job, error) => void errors.push({ job, error }),
    });

    queue.enqueue("project", "doomed");
    queue.enqueue("project", "newest");
    gates[0].reject(new Error("quota"));
    await Promise.resolve();
    await Promise.resolve();
    gates[1].resolve();
    await queue.idle();

    expect(errors).toHaveLength(1);
    expect(errors[0].job).toBe("doomed");
    expect(ran).toEqual(["doomed", "newest"]);
    expect(saved).toEqual(["newest"]);
  });

  it("starts a fresh job after the queue has drained", async () => {
    const ran: string[] = [];
    const queue = createCoalescingSaveQueue<string>({
      run: async (_key, job) => void ran.push(job),
    });

    queue.enqueue("project", "one");
    await queue.idle();
    queue.enqueue("project", "two");
    await queue.idle();

    expect(ran).toEqual(["one", "two"]);
    expect(queue.isBusy("project")).toBe(false);
  });
});
