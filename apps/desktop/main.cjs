const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");
const { createDesktopI18n } = require("./i18n.cjs");
const {
  assertPortAvailable,
  listenFailure,
  listenFailureMessage,
  portFallbackMessage,
  resolveDesktopPort,
} = require("./port.cjs");
const { createProjectFileQueue, readProjectFile, skfPathsFromArgv } = require("./projectFiles.cjs");
const {
  createUpdateInstaller,
  isSketchForgeDesktopServer,
  settlesWithin,
  singleFlight,
  spawnOwnedWebServer,
  stopProcess,
  watchProcess,
} = require("./webProcess.cjs");
const { whenWindowReady } = require("./windowReady.cjs");

const devUrl = process.env.SKETCHFORGE_DESKTOP_DEV_URL?.trim() || "";

const isLinux = process.platform === "linux";

let mainWindow = null;
let tray = null;
let webServer = null;
let webServerWatch = null;
let webServerUrl = null;
let webServerOutput = "";
// The SKETCHFORGE_DESKTOP_PORT value that was rejected, until the window shows the notice.
let rejectedPortValue = null;
let isQuitting = false;
let updaterConfigured = false;
let desktopIpcConfigured = false;
let updateCheckInFlight = false;
let manualUpdateCheck = false;
let downloadedUpdateReady = false;
let updateInstallRequested = false;
let lastUpdateCheckResult = null;
let lastUpdateCheckError = "";
let trayTooltip = () => "SketchForge";

// The window reports its resolved language over IPC; until then the OS language is used.
const desktopI18n = createDesktopI18n();
const { t } = desktopI18n;

function appendServerOutput(chunk) {
  webServerOutput += String(chunk);
  if (webServerOutput.length > 12_000) {
    webServerOutput = webServerOutput.slice(-12_000);
  }
}

async function waitForServer(url, port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (webServer && (webServer.exitCode !== null || webServerWatch.isClosed())) {
      // `exit` can come before the last stderr chunk, which is where a listen
      // error is reported, so read the output only once the streams have ended.
      // Another program can still take the port between the check and the listen.
      await settlesWithin(webServerWatch.closed, 2_000);
      const failure = listenFailure(webServerOutput);
      if (failure) throw new Error(listenFailureMessage(t, failure, port));
      throw new Error(t("desktop.startup.webProcessExited", { code: webServer.exitCode }));
    }

    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`${t("desktop.startup.webProcessTimeout")}${detail}`);
}

async function startPackagedWebServer() {
  // Starting again (macOS `activate` after the window closed) reuses the running
  // web process; a second one would find SketchForge's own port taken.
  if (webServerUrl && (!webServer || !webServerWatch || !webServerWatch.isClosed())) return webServerUrl;

  const webRoot = path.join(process.resourcesPath, "web");
  const serverPath = path.join(webRoot, "apps", "web", "server.js");
  if (!fs.existsSync(serverPath)) {
    throw new Error(t("desktop.startup.webBundleMissing", { path: serverPath }));
  }

  // Keep the desktop origin stable. localStorage and IndexedDB are scoped to
  // the full origin (including the port), so a random port made projects appear
  // to vanish after every restart. An invalid value uses the default, with a
  // console warning and a notice in the window, because the default port is a
  // different origin and so a different project list.
  const requestedPort = process.env.SKETCHFORGE_DESKTOP_PORT;
  const port = resolveDesktopPort(requestedPort, (warning) => {
    console.warn(warning);
    rejectedPortValue = requestedPort;
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await assertPortAvailable(port, "127.0.0.1");
  } catch (error) {
    const failure = listenFailure(error);
    if (failure === "inUse" && await isSketchForgeDesktopServer(url)) {
      // A process left by a forced quit of an older build still serves the
      // desktop app. Reuse it so the user can reopen their work immediately.
      webServerUrl = url;
      return url;
    }
    if (failure) throw new Error(listenFailureMessage(t, failure, port));
    throw error;
  }

  const packagedNodeModules = path.join(process.resourcesPath, "app.asar", "node_modules");

  webServerOutput = "";
  // Preserve the standalone server's argv while adding the IPC disconnect
  // handler that makes it exit if Electron is force-killed.
  const serverScript = `const serverPath = ${JSON.stringify(serverPath)};\nprocess.argv = [process.execPath, serverPath];\nrequire(serverPath);`;
  webServer = spawnOwnedWebServer(process.execPath, serverScript, {
    cwd: path.dirname(serverPath),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: [packagedNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      SKETCHFORGE_DESKTOP: "1",
      SKETCHFORGE_DESKTOP_VERSION: app.getVersion(),
      SKETCHFORGE_LOCAL_DOWNLOAD_ROOT: app.getPath("downloads"),
      SKETCHFORGE_SHARED_PROJECTS_DIR: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  webServerWatch = watchProcess(webServer);
  webServer.stdout?.on("data", appendServerOutput);
  webServer.stderr?.on("data", appendServerOutput);

  await waitForServer(url, port);
  webServerUrl = url;
  return url;
}

/** Stops the web process; resolves once it has exited and released its port. */
async function stopPackagedWebServer() {
  webServerUrl = null;
  if (!webServer || !webServerWatch) return;
  await stopProcess(webServer, webServerWatch);
}

/** Tells the user, once the window is up, that an invalid port value was replaced by the default. */
function showPortFallbackNotice(window) {
  if (rejectedPortValue === null) return;
  const rejected = rejectedPortValue;
  rejectedPortValue = null;
  whenWindowReady(window, () => {
    const { title, message } = portFallbackMessage(t, rejected);
    void dialog.showMessageBox(window, { type: "warning", title, message });
  });
}

function appIconPath() {
  return devUrl
    ? path.join(__dirname, "..", "web", "public", "assets", "sketchforge", "sketchforge-logo.png")
    : path.join(process.resourcesPath, "web", "apps", "web", "public", "assets", "sketchforge", "sketchforge-logo.png");
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Files the OS asked SketchForge to open. They wait here until the page has
// subscribed through the preload, because macOS sends `open-file` before the
// app is ready and a first launch's argv is known before the window exists.
// The queue reads one file at a time and keeps any file the page stopped
// listening for while it was read.
const projectFileQueue = createProjectFileQueue({
  read: (filePath) => readProjectFile(filePath),
  send: (file) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.webContents.send("sketchforge:open-project-file", file);
    return true;
  },
});

function openProjectFiles(filePaths) {
  if (!filePaths.length) return;
  projectFileQueue.add(filePaths);
  showMainWindow();
}

// The installer relaunches SketchForge, and the new instance needs the port the
// old web process holds, so the install waits for it to exit first.
const updateInstaller = createUpdateInstaller({
  stop: () => stopPackagedWebServer(),
  install: () => autoUpdater.quitAndInstall(false, true),
});

async function installDownloadedUpdate() {
  if (!downloadedUpdateReady) return;
  isQuitting = true;
  await updateInstaller.start();
}

async function downloadAndInstallDesktopUpdate() {
  if (!app.isPackaged) {
    return desktopUpdatePayload(null, t("desktop.updates.packagedOnly"));
  }

  lastUpdateCheckError = "";
  try {
    let result = lastUpdateCheckResult;
    if (!result?.isUpdateAvailable) {
      result = await autoUpdater.checkForUpdates();
      lastUpdateCheckResult = result;
    }
    if (!result?.isUpdateAvailable) {
      return desktopUpdatePayload(result);
    }

    updateInstallRequested = true;
    await autoUpdater.downloadUpdate();
    return desktopUpdatePayload(result);
  } catch (error) {
    updateInstallRequested = false;
    const message = error instanceof Error ? error.message : String(error);
    lastUpdateCheckError = message;
    return desktopUpdatePayload(lastUpdateCheckResult, message);
  }
}

function desktopUpdatePayload(result = lastUpdateCheckResult, errorMessage = lastUpdateCheckError) {
  return {
    currentVersion: app.getVersion(),
    latestVersion: result?.updateInfo?.version || null,
    updateAvailable: Boolean(result?.isUpdateAvailable),
    downloaded: downloadedUpdateReady,
    checkedAt: new Date().toISOString(),
    error: errorMessage || undefined,
  };
}

async function checkForDesktopUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) {
      await dialog.showMessageBox({
        type: "info",
        title: t("desktop.updates.title"),
        message: t("desktop.updates.devBuild"),
      });
    }
    return desktopUpdatePayload(null);
  }
  if (downloadedUpdateReady) {
    return desktopUpdatePayload();
  }
  if (updateCheckInFlight) {
    return desktopUpdatePayload();
  }

  manualUpdateCheck = manualUpdateCheck || manual;
  updateCheckInFlight = true;
  lastUpdateCheckError = "";
  try {
    const result = await autoUpdater.checkForUpdates();
    lastUpdateCheckResult = result;
    return desktopUpdatePayload(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastUpdateCheckError = message;
    if (manualUpdateCheck) {
      dialog.showErrorBox(t("desktop.updates.checkFailed"), message);
      manualUpdateCheck = false;
    }
    return desktopUpdatePayload(null, message);
  } finally {
    updateCheckInFlight = false;
  }
}

function setupDesktopIpc() {
  if (desktopIpcConfigured) return;
  desktopIpcConfigured = true;

  ipcMain.handle("sketchforge:get-version", () => app.getVersion());
  ipcMain.handle("sketchforge:check-for-updates", () => checkForDesktopUpdates(false));
  ipcMain.handle("sketchforge:install-update", () => downloadAndInstallDesktopUpdate());
  ipcMain.on("sketchforge:set-language", (_event, locale) => {
    if (desktopI18n.setLocale(locale)) refreshTrayText();
  });
  ipcMain.on("sketchforge:project-files-ready", (event) => {
    if (mainWindow && event.sender === mainWindow.webContents) projectFileQueue.rendererReady();
  });
  ipcMain.on("sketchforge:project-files-unready", (event) => {
    if (mainWindow && event.sender === mainWindow.webContents) projectFileQueue.rendererGone();
  });
}

function setupDesktopUpdater() {
  if (updaterConfigured || !app.isPackaged) return;
  updaterConfigured = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("update-available", (info) => {
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    void dialog.showMessageBox({
      type: "info",
      title: t("desktop.updates.availableTitle"),
      message: t("desktop.updates.available", { version: info.version }),
      detail: t("desktop.updates.availableDetail"),
    });
  });

  autoUpdater.on("update-not-available", () => {
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    void dialog.showMessageBox({
      type: "info",
      title: t("desktop.updates.title"),
      message: t("desktop.updates.upToDate"),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setTrayTooltip(() => t("desktop.tray.downloadingUpdate", { percent: Math.round(progress.percent) }));
  });

  autoUpdater.on("update-downloaded", (info) => {
    downloadedUpdateReady = true;
    setTrayTooltip(() => t("desktop.tray.updateReady", { version: info.version }));
    if (updateInstallRequested) void installDownloadedUpdate();
  });

  autoUpdater.on("error", (error) => {
    setTrayTooltip(() => "SketchForge");
    if (updateInstaller.isInProgress()) {
      // The installer failed instead of quitting. Its web process is already
      // stopped, so stop offering the install and let Quit simply quit.
      updateInstaller.failed();
      downloadedUpdateReady = false;
      updateInstallRequested = false;
      manualUpdateCheck = false;
      dialog.showErrorBox(t("desktop.updates.installFailed"), error instanceof Error ? error.message : String(error));
      return;
    }
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    dialog.showErrorBox(t("desktop.updates.installFailed"), error instanceof Error ? error.message : String(error));
  });

  setTimeout(() => void checkForDesktopUpdates(false), 4_000).unref();
  setInterval(() => void checkForDesktopUpdates(false), 6 * 60 * 60 * 1000).unref();
}

function setTrayTooltip(text) {
  trayTooltip = text;
  if (tray) tray.setToolTip(trayTooltip());
}

function refreshTrayText() {
  if (!tray) return;
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: t("desktop.tray.open"),
      click: showMainWindow,
    },
    {
      label: t("desktop.tray.checkForUpdates"),
      click: () => void checkForDesktopUpdates(true),
    },
    { type: "separator" },
    {
      label: t("desktop.tray.quit"),
      click: () => {
        // While an install is already under way, Quit quits rather than waiting on it.
        if (downloadedUpdateReady && !updateInstaller.isInProgress()) {
          void installDownloadedUpdate();
          return;
        }
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  if (tray) return;

  try {
    const icon = nativeImage.createFromPath(appIconPath()).resize({ width: 20, height: 20 });
    tray = new Tray(icon);
  } catch (error) {
    // Several Linux desktops ship no StatusNotifier host, so the tray is a
    // bonus rather than a requirement. Never let it block startup.
    console.warn(`SketchForge could not create a tray icon: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  refreshTrayText();
  tray.on("click", showMainWindow);
}

function createMainWindow(url) {
  const appOrigin = new URL(url).origin;
  const iconPath = appIconPath();

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: "SketchForge",
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try {
      const target = new URL(targetUrl);
      if (target.origin === appOrigin) return { action: "allow" };
      if (target.protocol === "http:" || target.protocol === "https:") {
        void shell.openExternal(targetUrl);
      }
    } catch {
      // Ignore malformed URLs instead of handing them to the OS.
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      if (target.origin === appOrigin) return;
      event.preventDefault();
      if (target.protocol === "http:" || target.protocol === "https:") {
        void shell.openExternal(targetUrl);
      }
    } catch {
      event.preventDefault();
    }
  });

  // A reload or a crash drops the page's subscription without unsubscribing,
  // so hold files again until the new page subscribes.
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) projectFileQueue.rendererGone();
  });
  mainWindow.webContents.on("render-process-gone", () => projectFileQueue.rendererGone());

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    // Hiding to the tray is only safe where a tray is dependable. GNOME has no
    // StatusNotifier host without an extension, so a hidden window would leave
    // SketchForge running with no way to reopen or quit it.
    if (isLinux) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    projectFileQueue.rendererGone();
  });

  void mainWindow.loadURL(url);
}

// macOS can send `activate` while the first start is still waiting for the web
// process, before the window exists; that call joins the start in flight
// instead of spawning a second web process onto SketchForge's own port.
const startDesktop = singleFlight(async () => {
  Menu.setApplicationMenu(null);

  try {
    const url = devUrl || await startPackagedWebServer();
    setupDesktopIpc();
    createTray();
    createMainWindow(url);
    showPortFallbackNotice(mainWindow);
    setupDesktopUpdater();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = webServerOutput.trim();
    dialog.showErrorBox(
      t("desktop.startup.failed"),
      detail ? `${message}\n\n${detail}` : message,
    );
    app.quit();
  }
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Windows and Linux pass a double-clicked file on the command line: to this
  // process on first launch, or to the running one through `second-instance`.
  openProjectFiles(skfPathsFromArgv(process.argv, process.cwd()));

  app.on("second-instance", (_event, argv, workingDirectory) => {
    showMainWindow();
    openProjectFiles(skfPathsFromArgv(argv, workingDirectory || process.cwd()));
  });

  // macOS sends files through `open-file` instead, before `ready` when the
  // file launched the app, so this listener is registered at startup.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    openProjectFiles(skfPathsFromArgv([process.execPath, filePath], process.cwd()));
  });

  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("com.sketchforge.desktop");
    desktopI18n.setLocale(desktopI18n.resolveLocale([...app.getPreferredSystemLanguages(), app.getLocale()]));
    void startDesktop();

    app.on("activate", () => {
      // The update install has stopped the web process on purpose; starting
      // again would report its own port as busy, or quit before the install.
      if (updateInstaller.isInProgress()) return;
      if (mainWindow) {
        showMainWindow();
      } else if (BrowserWindow.getAllWindows().length === 0) {
        void startDesktop();
      }
    });
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  void stopPackagedWebServer();
});

app.on("window-all-closed", () => {
  // Keep SketchForge available from the system tray. Use Quit SketchForge
  // from the tray menu when the user wants to fully stop the application.
  // Linux desktops cannot rely on a tray, and closing the last window is the
  // expected way to quit there, so honour that instead.
  if (isLinux) app.quit();
});
