import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import windowReadyModule from "../../apps/desktop/windowReady.cjs";

const { whenWindowReady } = windowReadyModule;

/** A stand-in for a BrowserWindow: visibility, loading state, and the events that change them. */
function fakeWindow({ visible = false, loading = true } = {}) {
  const webContents = Object.assign(new EventEmitter(), { isLoading: () => loading });
  const window = Object.assign(new EventEmitter(), {
    webContents,
    destroyed: false,
    isVisible: () => visible,
    isDestroyed: () => window.destroyed,
  });
  return {
    window,
    show() {
      visible = true;
      window.emit("show");
    },
    finishLoading() {
      loading = false;
      webContents.emit("did-finish-load");
    },
    startLoading() {
      loading = true;
      webContents.emit("did-start-loading");
    },
  };
}

describe("whenWindowReady", () => {
  it("runs once the window is shown after its page has loaded", () => {
    const fake = fakeWindow();
    const run = vi.fn();
    whenWindowReady(fake.window, run);
    fake.finishLoading();
    expect(run).not.toHaveBeenCalled();
    fake.show();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs once the page loads after the window was shown", () => {
    const fake = fakeWindow();
    const run = vi.fn();
    whenWindowReady(fake.window, run);
    fake.show();
    expect(run).not.toHaveBeenCalled();
    fake.finishLoading();
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Seen in the packaged app: the page starts a second navigation as it finishes
  // loading, so isLoading() still reports true inside did-finish-load, and no
  // later event re-checks. The events themselves must count.
  it("runs when isLoading() still reports true during did-finish-load", () => {
    const fake = fakeWindow();
    const run = vi.fn();
    whenWindowReady(fake.window, run);
    fake.show();
    fake.window.webContents.emit("did-finish-load");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs when isVisible() still reports false during show", () => {
    const fake = fakeWindow({ loading: false });
    const run = vi.fn();
    whenWindowReady(fake.window, run);
    fake.window.emit("show");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs at once when both already happened before it was called", () => {
    const fake = fakeWindow({ visible: true, loading: false });
    const run = vi.fn();
    whenWindowReady(fake.window, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits when only one of the two already happened", () => {
    const shown = fakeWindow({ visible: true, loading: true });
    const loaded = fakeWindow({ visible: false, loading: false });
    const runShown = vi.fn();
    const runLoaded = vi.fn();
    whenWindowReady(shown.window, runShown);
    whenWindowReady(loaded.window, runLoaded);
    expect(runShown).not.toHaveBeenCalled();
    expect(runLoaded).not.toHaveBeenCalled();
    shown.finishLoading();
    loaded.show();
    expect(runShown).toHaveBeenCalledTimes(1);
    expect(runLoaded).toHaveBeenCalledTimes(1);
  });

  it("runs only once across reloads and repeated shows, and stops listening", () => {
    const fake = fakeWindow();
    const run = vi.fn();
    whenWindowReady(fake.window, run);
    fake.show();
    fake.finishLoading();
    fake.startLoading();
    fake.finishLoading();
    fake.show();
    expect(run).toHaveBeenCalledTimes(1);
    expect(fake.window.listenerCount("show")).toBe(0);
    expect(fake.window.webContents.listenerCount("did-finish-load")).toBe(0);
    expect(fake.window.listenerCount("closed")).toBe(0);
  });

  it("never runs for a window closed before it was ready, and stops listening", () => {
    const fake = fakeWindow();
    const run = vi.fn();
    whenWindowReady(fake.window, run);
    fake.window.destroyed = true;
    fake.window.emit("closed");
    fake.show();
    fake.finishLoading();
    expect(run).not.toHaveBeenCalled();
    expect(fake.window.listenerCount("show")).toBe(0);
    expect(fake.window.webContents.listenerCount("did-finish-load")).toBe(0);
  });

  it("never runs for a window that is already destroyed", () => {
    const fake = fakeWindow({ visible: true, loading: false });
    fake.window.destroyed = true;
    const run = vi.fn();
    whenWindowReady(fake.window, run);
    expect(run).not.toHaveBeenCalled();
  });
});
