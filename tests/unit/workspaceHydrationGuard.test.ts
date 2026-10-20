import { describe, expect, it } from "vitest";
import { workspaceHydrationSyncDecision } from "@/lib/engine/workplaneSettings";

/**
 * Models the two effects in WorkplaneViewport that share
 * pendingWorkspaceHydrationFingerprintRef:
 *
 * - a layout effect that hydrates from props and arms the guard, so freshly
 *   loaded settings are not echoed back to the parent;
 * - a passive effect, keyed on [snap, workspace], that reports a change
 *   upward unless the guard says it is that echo.
 *
 * The passive effect only runs when its deps change, which is what makes the
 * guard outlive a hydration that changes no state.
 */
function viewportHarness(initialFingerprint: string) {
  let pending: string | null = null;
  let committed = initialFingerprint;
  const synced: string[] = [];

  const runSyncEffect = () => {
    const decision = workspaceHydrationSyncDecision(pending, committed);
    pending = decision.pendingFingerprint;
    if (decision.shouldSync) synced.push(committed);
  };

  return {
    synced,
    /** The layout effect: arm the guard, then push hydrated values into state. */
    hydrate(fingerprint: string) {
      pending = fingerprint;
      const changed = committed !== fingerprint;
      committed = fingerprint;
      // The passive effect is keyed on the state it would have changed.
      if (changed) runSyncEffect();
    },
    /** Mount runs the passive effect once regardless of dep changes. */
    mount() {
      runSyncEffect();
    },
    /** A grid picked from a control, as the unfixed code recorded it. */
    chooseUnfixed(fingerprint: string) {
      committed = fingerprint;
      runSyncEffect();
    },
    /** A grid picked from a control, with chooseSnapGrid's disarm. */
    chooseFixed(fingerprint: string) {
      pending = null;
      committed = fingerprint;
      runSyncEffect();
    },
  };
}

describe("workspace hydration guard", () => {
  it("spends the guard on mount, so a first choice right after mount is reported", () => {
    const viewport = viewportHarness("grid:1.0 mm");
    viewport.hydrate("grid:1.0 mm");
    viewport.mount();
    viewport.chooseUnfixed("grid:5.0 mm");
    expect(viewport.synced).toEqual(["grid:5.0 mm"]);
  });

  it("leaves the guard armed when a re-hydration changes no state", () => {
    // The parent persists settings and passes back new object references even
    // when the values are unchanged, which re-runs the layout effect.
    const viewport = viewportHarness("grid:1.0 mm");
    viewport.hydrate("grid:1.0 mm");
    viewport.mount();
    viewport.chooseUnfixed("grid:5.0 mm");
    expect(viewport.synced).toEqual(["grid:5.0 mm"]);

    // Re-hydration with the values already in state: the passive effect's deps
    // do not change, so it never runs and never spends the guard.
    viewport.hydrate("grid:5.0 mm");

    // The next choice is swallowed, and stays swallowed: the guard only clears
    // when the committed fingerprint happens to match it again.
    viewport.chooseUnfixed("grid:0.5 mm");
    viewport.chooseUnfixed("grid:2.0 mm");
    expect(viewport.synced).toEqual(["grid:5.0 mm"]);
  });

  it("reports every choice once a user choice disarms the guard", () => {
    const viewport = viewportHarness("grid:1.0 mm");
    viewport.hydrate("grid:1.0 mm");
    viewport.mount();
    viewport.hydrate("grid:1.0 mm");

    viewport.chooseFixed("grid:0.5 mm");
    viewport.chooseFixed("grid:2.0 mm");
    expect(viewport.synced).toEqual(["grid:0.5 mm", "grid:2.0 mm"]);
  });

  it("still suppresses the hydration echo itself", () => {
    // The guard's original purpose: a hydration that does change state must not
    // be reported back to the parent that just sent it.
    const viewport = viewportHarness("grid:1.0 mm");
    viewport.hydrate("grid:5.0 mm");
    expect(viewport.synced).toEqual([]);
  });
});
