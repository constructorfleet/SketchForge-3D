export interface UpdateAvailableInfo {
  version: string;
}

export interface UpdateNotificationOptions {
  manualUpdateCheck: boolean;
  clearManualCheck: () => void;
  showNotice: (info: UpdateAvailableInfo) => void;
}

export function handleUpdateAvailable(
  info: UpdateAvailableInfo,
  options: UpdateNotificationOptions,
): void;
