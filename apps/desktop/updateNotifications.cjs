function handleUpdateAvailable(info, { manualUpdateCheck, clearManualCheck, showNotice }) {
  if (manualUpdateCheck) clearManualCheck();
  showNotice(info);
}

module.exports = { handleUpdateAvailable };
