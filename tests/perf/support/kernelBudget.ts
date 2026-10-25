export type KernelBudget = { wallMs: number; heapDeltaMb: number };

export function assertKernelBudget(measured: KernelBudget, budget: KernelBudget): void {
  if (measured.wallMs > budget.wallMs) {
    throw new Error(`Kernel wall time ${measured.wallMs.toFixed(2)} ms exceeds ${budget.wallMs} ms`);
  }
  if (measured.heapDeltaMb > budget.heapDeltaMb) {
    throw new Error(`Kernel heap delta ${measured.heapDeltaMb.toFixed(2)} MiB exceeds ${budget.heapDeltaMb} MiB`);
  }
}
