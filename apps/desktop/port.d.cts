/** Types for port.cjs, which the desktop main process loads as plain CommonJS. */

import type { DesktopI18n } from "./i18n.cjs";

export type ListenFailure = "inUse" | "accessDenied";

declare const desktopPort: {
  DEFAULT_DESKTOP_PORT: number;
  DESKTOP_PORT_VARIABLE: "SKETCHFORGE_DESKTOP_PORT";
  /** The port for a SKETCHFORGE_DESKTOP_PORT value; invalid values warn and fall back to the default. */
  resolveDesktopPort: (value: string | undefined, warn?: (message: string) => void) => number;
  /** Why listening failed, from the listen error or the web process's output; null when it is neither. */
  listenFailure: (errorOrOutput: unknown) => ListenFailure | null;
  /** Resolves when the port can be listened on (and releases it); rejects with the listen error. */
  assertPortAvailable: (port: number, host: string) => Promise<void>;
  /** The localized startup error for a listen failure. */
  listenFailureMessage: (t: DesktopI18n["t"], kind: ListenFailure, port: number) => string;
  /** The localized notice for a rejected SKETCHFORGE_DESKTOP_PORT value. */
  portFallbackMessage: (t: DesktopI18n["t"], rejectedValue: string) => { title: string; message: string };
};

export = desktopPort;
