/**
 * A project the engine can read and write, behind one interface.
 *
 * `docs/ENGINE_EXTRACTION.md` section 5 asks for this seam so that the thing
 * holding a project is an argument rather than an import. Today there is one
 * implementation, over the server's project directory, and it is the same
 * `node:fs` code the route handlers were calling directly. The point of naming
 * it is what comes next: an offline macro runner (PR 7) hands `createEngine` a
 * store over a directory or a single `.skf` and gets the project lock, the
 * revision bump and the undo entry for free -- all three of which a macro
 * writing a directory needs and none of which it has today.
 *
 * `withLock` is part of the interface rather than an implementation detail
 * because it is the only thing standing between two concurrent writers and a
 * lost edit, and a store that cannot lock has to say so.
 */

import {
  listProjectRecords,
  withProjectLock,
  type ProjectMetadata,
} from "@/lib/engine/serverProjectFiles";
import {
  readProjectDocument,
  writeProjectDocument,
  type ProjectDocument,
} from "@/lib/engine/serverProjectDocument";
import type { ServerProjectRecord } from "@/lib/serverProjectStore";
import type { WorkplaneShape } from "@/types/sketchforge";

export type { ProjectDocument, ProjectMetadata };

export type ProjectStore = {
  /** The project's metadata and shapes, or null when it is not there. */
  read(projectId: string): Promise<ProjectDocument | null>;
  /** Store a new shape list, advancing the revision the way the editor does. */
  write(projectId: string, document: ProjectDocument, shapes: WorkplaneShape[]): Promise<{ revision: number }>;
  /**
   * Run `work` holding the project's lock, or report the project busy.
   *
   * `result` is present exactly when `busy` is false. It is optional in the
   * type because there is nothing to return when the lock was not taken.
   */
  withLock<T>(projectId: string, work: () => Promise<T>): Promise<{ busy: boolean; result?: T }>;
  /** Every project the store holds, newest first. */
  list(): Promise<ServerProjectRecord[]>;
};

/**
 * The store over a server project directory.
 *
 * `root` is the directory `SKETCHFORGE_PROJECTS_DIR` names, already created --
 * `apiContext` does that, and so would a macro runner's own setup.
 */
export function directoryProjectStore(root: string): ProjectStore {
  return {
    read: (projectId) => readProjectDocument(root, projectId),
    write: async (projectId, document, shapes) => {
      const { revision } = await writeProjectDocument(root, projectId, document, shapes);
      return { revision };
    },
    withLock: (projectId, work) => withProjectLock(root, projectId, work),
    list: () => listProjectRecords(root),
  };
}
