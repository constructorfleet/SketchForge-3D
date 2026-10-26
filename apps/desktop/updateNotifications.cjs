function handleUpdateAvailable(info, { manualUpdateCheck, clearManualCheck, showNotice, notifiedVersions }) {
  if (manualUpdateCheck) clearManualCheck();
  if (notifiedVersions.has(info.version)) return;
  notifiedVersions.add(info.version);
  showNotice(info);
}

module.exports = { handleUpdateAvailable };
