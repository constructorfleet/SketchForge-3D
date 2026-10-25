import { describe, expect, it } from "vitest";
import { assertKernelBudget } from "../perf/support/kernelBudget";

describe("kernel benchmark budgets", () => {
  const budget = { wallMs: 100, heapDeltaMb: 20 };
  it("fails when a kernel operation exceeds its wall-time budget", () => {
    expect(() => assertKernelBudget({ wallMs: 101, heapDeltaMb: 0 }, budget)).toThrow(/wall time/);
  });
  it("fails when retained JS heap exceeds its budget", () => {
    expect(() => assertKernelBudget({ wallMs: 50, heapDeltaMb: 21 }, budget)).toThrow(/heap/);
  });
  it("accepts the limit and negative heap deltas from garbage collection", () => {
    expect(() => assertKernelBudget(budget, budget)).not.toThrow();
    expect(() => assertKernelBudget({ wallMs: 50, heapDeltaMb: -10 }, budget)).not.toThrow();
  });
});
