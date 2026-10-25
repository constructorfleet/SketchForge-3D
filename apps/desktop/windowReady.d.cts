/** Types for windowReady.cjs, which the desktop main process loads as plain CommonJS. */

import type { EventEmitter } from "node:events";

export type ReadyWindow = EventEmitter & {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  webContents: EventEmitter & { isLoading: () => boolean };
};

declare const windowReady: {
  /** Calls `run` once, when the window is visible and its page has finished loading (at once if it already is). */
  whenWindowReady: (window: ReadyWindow, run: () => void) => void;
};

export = windowReady;
