/** Types for projectFiles.cjs, which the desktop main process loads as plain CommonJS. */

import type { FileHandle } from "node:fs/promises";
import type { PlatformPath } from "node:path";

export type ProjectFilePayload =
  | { fileName: string; bytes: Uint8Array }
  | { fileName: string; error: "tooLarge" | "unreadable" };

export type ProjectFileQueue = {
  /** Queue OS-provided project paths; delivered at once while the page listens. */
  add: (filePaths: readonly string[]) => void;
  /** The page subscribed: deliver everything held so far. */
  rendererReady: () => void;
  /** The page unsubscribed or is reloading: hold files again. */
  rendererGone: () => void;
  /** Resolves once nothing is being read or sent. */
  idle: () => Promise<void>;
};

declare const projectFiles: {
  SKF_ARCHIVE_BYTE_LIMIT: number;
  createProjectFileQueue: <File>(io: {
    read: (filePath: string) => Promise<File>;
    /** False when no window can take the file; it is kept for the next subscription. */
    send: (file: File) => boolean;
  }) => ProjectFileQueue;
  readProjectFile: (
    filePath: string,
    options?: { limit?: number; open?: (filePath: string, flags: number) => Promise<FileHandle> },
  ) => Promise<ProjectFilePayload>;
  skfPathsFromArgv: (argv: readonly unknown[] | undefined, cwd: string, options?: { pathApi?: PlatformPath }) => string[];
};

export = projectFiles;
