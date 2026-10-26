export interface UpdateAvailableInfo {
  version: string;
}

export interface UpdateNotificationOptions {
  manualUpdateCheck: boolean;
  clearManualCheck: () => void;
  showNotice: (info: UpdateAvailableInfo) => void;
  notifiedVersions: Set<string>;
}

export function handleUpdateAvailable(
  info: UpdateAvailableInfo,
  options: UpdateNotificationOptions,
): void;
