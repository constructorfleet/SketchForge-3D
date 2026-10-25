/** Types for webProcess.cjs, which the desktop main process loads as plain CommonJS. */

import type { ChildProcess } from "node:child_process";

export type ProcessWatch = {
  /** Settles once the process exited and its stdio streams ended, or it never spawned. */
  closed: Promise<void>;
  isClosed: () => boolean;
};

declare const webProcess: {
  watchProcess: (child: ChildProcess) => ProcessWatch;
  /** True when the promise settled within `ms`. */
  settlesWithin: (promise: Promise<unknown>, ms: number) => Promise<boolean>;
  /** Stops the process, escalating to SIGKILL after `graceMs`; resolves once it closed. */
  stopProcess: (child: ChildProcess, watch: ProcessWatch, options?: { graceMs?: number }) => Promise<void>;
  /** Stops the web process, then installs; in progress until `failed()` or the app quits. */
  createUpdateInstaller: (io: { stop: () => Promise<void>; install: () => void }) => {
    isInProgress: () => boolean;
    /** False when an install is already in progress. */
    start: () => Promise<boolean>;
    /** The installer reported an error instead of quitting. */
    failed: () => void;
  };
  /** Overlapping calls share the run in flight. */
  singleFlight: <T>(run: () => T | Promise<T>) => () => Promise<T>;
};

export = webProcess;
