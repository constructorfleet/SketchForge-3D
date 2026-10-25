// Runs something once a BrowserWindow is both visible and finished loading.
// No Electron imports so it can be unit-tested with a stand-in window.

/**
 * Calls `run` exactly once, as soon as `window` has been shown and its page
 * has finished loading, whichever of `show` and `did-finish-load` comes last.
 *
 * Each condition is latched from its event rather than re-read from the
 * window: SketchForge's page starts a second navigation as it finishes
 * loading, so `isLoading()` can still report true inside `did-finish-load`,
 * and no later event would check again. `isVisible()` and `isLoading()` are
 * read only once, up front, so a window that is already shown or loaded does
 * not wait for an event that has already fired.
 *
 * Never runs for a window that is destroyed or closes first; every listener
 * it adds is removed once it runs or the window closes.
 */
function whenWindowReady(window, run) {
  if (window.isDestroyed()) return;
  const { webContents } = window;
  let shown = window.isVisible();
  let loaded = !webContents.isLoading();
  let settled = false;

  function cleanup() {
    window.removeListener("show", onShow);
    webContents.removeListener("did-finish-load", onLoad);
    window.removeListener("closed", abandon);
  }

  function abandon() {
    settled = true;
    cleanup();
  }

  function check() {
    if (settled) return;
    if (window.isDestroyed()) return abandon();
    if (!shown || !loaded) return;
    settled = true;
    cleanup();
    run();
  }

  function onShow() {
    shown = true;
    check();
  }

  function onLoad() {
    loaded = true;
    check();
  }

  window.on("show", onShow);
  webContents.on("did-finish-load", onLoad);
  window.once("closed", abandon);
  check();
}

module.exports = { whenWindowReady };
