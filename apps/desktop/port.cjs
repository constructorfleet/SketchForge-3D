// The packaged desktop app's loopback port: reading SKETCHFORGE_DESKTOP_PORT,
// checking the port is free, and explaining a busy port. No Electron imports
// so it can be unit-tested.

const net = require("node:net");

// Keep the desktop origin stable. localStorage and IndexedDB are scoped to the
// full origin (including the port), so a random port made projects appear to
// vanish after every restart.
const DEFAULT_DESKTOP_PORT = 62158;
const DESKTOP_PORT_VARIABLE = "SKETCHFORGE_DESKTOP_PORT";
const MAX_PORT = 65535;

/**
 * The port for a SKETCHFORGE_DESKTOP_PORT value. Unset or blank means the
 * default. Anything other than a whole number from 1 to 65535 also means the
 * default, with a warning: the fallback moves the app to a different storage
 * origin, so saved projects seem to disappear, and that must not be silent.
 * Port 0 is refused because the OS would pick a new port, and origin, on
 * every launch.
 */
function resolveDesktopPort(value, warn = console.warn) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return DEFAULT_DESKTOP_PORT;
  if (/^\d+$/.test(text)) {
    const port = Number(text);
    if (port >= 1 && port <= MAX_PORT) return port;
  }
  warn(
    `SketchForge ignored ${DESKTOP_PORT_VARIABLE}=${JSON.stringify(value)}: it must be a whole number from 1 to ${MAX_PORT}. `
    + `Using port ${DEFAULT_DESKTOP_PORT} instead. Projects are stored per port, so projects saved under another port will not appear.`,
  );
  return DEFAULT_DESKTOP_PORT;
}

/**
 * Why listening on the port failed, from the listen error or the web process's
 * output: "inUse" (EADDRINUSE: another program holds it), "accessDenied"
 * (EACCES: for example a port below 1024 on Linux), or null for anything else.
 */
function listenFailure(errorOrOutput) {
  if (!errorOrOutput) return null;
  const code = typeof errorOrOutput === "string"
    ? /\b(EADDRINUSE|EACCES)\b/.exec(errorOrOutput)?.[1]
    : errorOrOutput.code;
  if (code === "EADDRINUSE") return "inUse";
  if (code === "EACCES") return "accessDenied";
  return null;
}

/**
 * Resolves when `host:port` can be listened on, and releases it again; rejects
 * with the listen error (code EADDRINUSE when another program holds it).
 * Checked before the web process starts because, if the program holding the
 * port answers HTTP, the startup poll would otherwise load that program's page.
 */
function assertPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(port, host, () => probe.close(() => resolve(undefined)));
  });
}

const LISTEN_FAILURE_KEYS = {
  inUse: "desktop.startup.portInUse",
  accessDenied: "desktop.startup.portAccessDenied",
};

/** The localized startup error for a `listenFailure` kind, naming the port and the variable that moves it. */
function listenFailureMessage(t, kind, port) {
  return t(LISTEN_FAILURE_KEYS[kind], { port, variable: DESKTOP_PORT_VARIABLE });
}

/**
 * The localized notice shown once the window is up when an invalid value fell
 * back to the default port. The console warning alone is invisible to an app
 * started from the Dock or Start menu, where projects would just seem to vanish.
 */
function portFallbackMessage(t, rejectedValue) {
  return {
    title: t("desktop.startup.portFallbackTitle"),
    message: t("desktop.startup.portFallback", {
      value: String(rejectedValue),
      port: DEFAULT_DESKTOP_PORT,
      variable: DESKTOP_PORT_VARIABLE,
    }),
  };
}

module.exports = {
  DEFAULT_DESKTOP_PORT,
  DESKTOP_PORT_VARIABLE,
  assertPortAvailable,
  listenFailure,
  listenFailureMessage,
  portFallbackMessage,
  resolveDesktopPort,
};
