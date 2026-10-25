export {};

type SketchForgeDesktopUpdateResult = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  downloaded: boolean;
  checkedAt: string;
  error?: string;
};

/**
 * A project file the OS asked SketchForge to open (double-click, Open With, a
 * path on the command line). The main process reads it, so the renderer never
 * names a path: it gets either the bytes or the reason they are missing.
 */
export type DesktopProjectFile =
  | { fileName: string; bytes: Uint8Array }
  | { fileName: string; error: "tooLarge" | "unreadable" };

declare global {
  interface Window {
    sketchforgeDesktop?: {
      getVersion: () => Promise<string>;
      checkForUpdates: () => Promise<SketchForgeDesktopUpdateResult>;
      installUpdate: () => Promise<SketchForgeDesktopUpdateResult>;
      /** Locale code resolved by the web UI; the main process uses it for tray and dialog text. */
      setLanguage: (locale: string) => void;
      /**
       * Receive `.skf` files the OS opened with SketchForge. Subscribing tells
       * the main process the window is listening, which releases any file that
       * arrived during startup. Call the returned function to unsubscribe.
       * Optional because an older desktop shell may serve a newer web bundle.
       */
      onOpenProjectFile?: (callback: (file: DesktopProjectFile) => void) => () => void;
    };
  }
}
