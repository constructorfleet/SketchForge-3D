"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations, type Translator } from "@/i18n";
import { browserStorageManager, readStorageStatus, storageUsageFraction, type StorageStatus } from "@/lib/storageHealth";

function formatStorageSize(t: Translator, locale: string, bytes: number) {
  const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
  if (bytes < 1024) return t("dashboard.fileSize.bytes", { size: format(bytes) });
  if (bytes < 1024 ** 2) return t("dashboard.fileSize.kilobytes", { size: format(bytes / 1024) });
  if (bytes < 1024 ** 3) return t("dashboard.fileSize.megabytes", { size: format(bytes / 1024 ** 2) });
  return t("dashboard.fileSize.gigabytes", { size: format(bytes / 1024 ** 3) });
}

/**
 * Workspace Settings > Storage: whether the browser keeps projects, and how much space they use (issue #333).
 * With server storage the projects are not in the browser at all, so the section says that instead.
 */
export function WorkspaceStorageSection({ projectsStoredOnServer = false }: { projectsStoredOnServer?: boolean }) {
  const t = useTranslations();
  const locale = useLocale();
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [requestDeclined, setRequestDeclined] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (projectsStoredOnServer) return;
    let canceled = false;
    void readStorageStatus(browserStorageManager()).then((next) => {
      if (!canceled) setStatus(next);
    });
    return () => {
      canceled = true;
    };
  }, [projectsStoredOnServer]);

  // A click is a user gesture, which some browsers require before they grant
  // persistence, so this asks even when the once-per-profile request was made.
  const requestPersistence = async () => {
    const storage = browserStorageManager();
    if (!storage?.persist) return;
    setRequesting(true);
    try {
      const granted = await storage.persist().catch(() => false);
      setRequestDeclined(!granted);
      setStatus(await readStorageStatus(storage));
    } finally {
      setRequesting(false);
    }
  };

  const fraction = status ? storageUsageFraction(status) : null;
  const percent = fraction === null ? "" : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(fraction);

  return (
    <>
      <div className="workspace-section-heading">
        <strong>{t("panels.settings.storage.title")}</strong>
        <span>{t("panels.settings.storage.description")}</span>
      </div>
      {projectsStoredOnServer ? (
        <div className="workspace-storage-status">
          <div className="workspace-storage-row" data-storage-persistence="server">
            <strong>{t("panels.settings.storage.persistence")}</strong>
            <span>{t("panels.settings.storage.server")}</span>
          </div>
          <p className="workspace-history-note">{t("panels.settings.storage.backupNote")}</p>
        </div>
      ) : status === null ? (
        <p className="workspace-history-note" role="status">{t("panels.settings.storage.checking")}</p>
      ) : (
        <div className="workspace-storage-status">
          <div className="workspace-storage-row" data-storage-persistence={status.persistence}>
            <strong>{t("panels.settings.storage.persistence")}</strong>
            <span>
              {status.persistence === "persisted"
                ? t("panels.settings.storage.persisted")
                : status.persistence === "best-effort"
                  ? t("panels.settings.storage.bestEffort")
                  : t("panels.settings.storage.unsupported")}
            </span>
            {status.persistence === "best-effort" ? (
              <button className="workspace-storage-request" type="button" onClick={() => void requestPersistence()} disabled={requesting}>
                {t("panels.settings.storage.request")}
              </button>
            ) : null}
            {requestDeclined && status.persistence !== "persisted" ? (
              <span className="workspace-storage-declined" role="status">{t("panels.settings.storage.requestDeclined")}</span>
            ) : null}
          </div>
          <div className="workspace-storage-row">
            <strong>{t("panels.settings.storage.usage")}</strong>
            {fraction !== null && status.usage !== null && status.quota !== null ? (
              <>
                <span>
                  {t("panels.settings.storage.usageValue", {
                    used: formatStorageSize(t, locale, status.usage),
                    quota: formatStorageSize(t, locale, status.quota),
                    percent,
                  })}
                </span>
                <meter
                  className="workspace-storage-meter"
                  min={0}
                  max={1}
                  low={0.6}
                  high={0.8}
                  optimum={0}
                  value={fraction}
                  aria-label={t("panels.settings.storage.usageMeter")}
                />
              </>
            ) : (
              <span>{t("panels.settings.storage.usageUnknown")}</span>
            )}
          </div>
          <p className="workspace-history-note">{t("panels.settings.storage.backupNote")}</p>
        </div>
      )}
    </>
  );
}
