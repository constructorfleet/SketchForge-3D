// Lifecycle helpers for the packaged desktop app's web process. No Electron
// imports so they can be unit-tested.

/**
 * Tracks when a child process is fully closed: exited *and* its stdio streams
 * ended. `exit` can fire before the last stderr chunk arrives, and that chunk
 * is where a listen error such as EADDRINUSE is reported, so classify the
 * output only after `closed` settles. A process that never spawned emits
 * `error` without a pid and may never emit `close`; that also settles it.
 */
function watchProcess(child) {
  let isClosed = false;
  const closed = new Promise((resolve) => {
    const settle = () => {
      isClosed = true;
      resolve(undefined);
    };
    child.once("close", settle);
    child.once("error", () => {
      if (child.pid === undefined) settle();
    });
  });
  return { closed, isClosed: () => isClosed };
}

/** True when `promise` settled within `ms`. */
function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Stops the process and resolves once it has closed, so its port is free
 * before anything starts on it again. A process that ignores the polite signal
 * for `graceMs` is killed outright. Never rejects.
 */
async function stopProcess(child, watch, { graceMs = 5_000 } = {}) {
  if (watch.isClosed()) return;
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  if (await settlesWithin(watch.closed, graceMs)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  await settlesWithin(watch.closed, graceMs);
}

/**
 * Wraps an async function so overlapping calls share the run in flight instead
 * of starting another. Once it settles, the next call runs again.
 */
function singleFlight(run) {
  let inFlight = null;
  return () => {
    if (!inFlight) {
      inFlight = (async () => run())()
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}

/**
 * Installs a downloaded update: stops the web process (so the relaunched app
 * can take its port), then hands over to the installer. It is in progress from
 * `start()` until the app quits, so callers can avoid restarting the web
 * process or starting a second install meanwhile. If the installer reports an
 * error instead of quitting, `failed()` clears it, so Quit and a later install
 * work again; a failure to stop the web process clears it too.
 */
function createUpdateInstaller({ stop, install }) {
  let inProgress = false;
  return {
    isInProgress: () => inProgress,
    async start() {
      if (inProgress) return false;
      inProgress = true;
      try {
        await stop();
        install();
      } catch (error) {
        inProgress = false;
        throw error;
      }
      return true;
    },
    failed() {
      inProgress = false;
    },
  };
}

module.exports = { createUpdateInstaller, settlesWithin, singleFlight, stopProcess, watchProcess };
