const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sketchforgeDesktop", {
  getVersion: () => ipcRenderer.invoke("sketchforge:get-version"),
  checkForUpdates: () => ipcRenderer.invoke("sketchforge:check-for-updates"),
  installUpdate: () => ipcRenderer.invoke("sketchforge:install-update"),
  setLanguage: (locale) => ipcRenderer.send("sketchforge:set-language", locale),
  // The main process holds files the OS opened until a page subscribes here,
  // so a double-clicked .skf that launched the app is not lost during startup.
  onOpenProjectFile: (callback) => {
    const listener = (_event, file) => callback(file);
    ipcRenderer.on("sketchforge:open-project-file", listener);
    ipcRenderer.send("sketchforge:project-files-ready");
    return () => {
      ipcRenderer.removeListener("sketchforge:open-project-file", listener);
      ipcRenderer.send("sketchforge:project-files-unready");
    };
  },
});
