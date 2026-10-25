const fs = require("node:fs");
const nodePath = require("node:path");
const { fileURLToPath } = require("node:url");

/**
 * Largest `.skf` the main process reads from disk. Mirrors the engine's
 * `SKF_LIMITS.archiveBytes`, which the renderer enforces again on import;
 * the main process cannot import the engine, and a unit test keeps the two equal.
 */
const SKF_ARCHIVE_BYTE_LIMIT = 512 * 1024 * 1024;

const SKF_EXTENSION = /\.skf$/i;
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * The `.skf` project paths in an argv that the OS or a second launch handed
 * to SketchForge, resolved to absolute paths in argv order without duplicates.
 *
 * argv[0] is always the executable. A dev launch (`electron main.cjs ...`)
 * adds the main script, and Chromium appends switches such as
 * `--allow-file-access-from-files` to the argv a `second-instance` event
 * reports, so anything that is not a `.skf` path or `file://` URI is skipped.
 * Linux desktop entries pass `%U`, which arrives as `file://` URIs.
 *
 * The path rules default to the host's, which is what the main process
 * wants; tests pass `path.posix` or `path.win32` to check either platform
 * on any host.
 *
 * @param {readonly unknown[] | undefined} argv
 * @param {string} cwd Directory the launch ran in, for relative paths.
 * @param {{ pathApi?: typeof nodePath.posix }} [options]
 * @returns {string[]}
 */
function skfPathsFromArgv(argv, cwd, { pathApi = nodePath } = {}) {
  if (!Array.isArray(argv)) return [];
  const windows = pathApi === nodePath.win32;
  const paths = [];
  for (const arg of argv.slice(1)) {
    const filePath = argToPath(arg, cwd, pathApi, windows);
    if (filePath && SKF_EXTENSION.test(filePath) && !paths.includes(filePath)) paths.push(filePath);
  }
  return paths;
}

function argToPath(arg, cwd, pathApi, windows) {
  if (typeof arg !== "string" || !arg || arg.startsWith("-")) return null;
  if (/^file:\/\//i.test(arg)) {
    try {
      // A URI's own platform decides how it reads: file:///C:/x on Windows,
      // file:///home/x elsewhere. A drive-less URI is not a Windows path.
      return pathApi.normalize(fileURLToPath(arg, { windows }));
    } catch {
      return null;
    }
  }
  // Other URL schemes (http:, sketchforge:) are never local projects. A
  // Windows drive letter such as `C:\` is a path, not a scheme.
  if (/^[a-z][a-z0-9+.-]+:/i.test(arg)) return null;
  return pathApi.resolve(cwd, arg);
}

/**
 * Read a project for the renderer from an open handle, never more than
 * `limit` + 1 bytes, so an oversized file is refused without loading it and
 * the size check cannot race a file that grows after a separate stat.
 *
 * @param {string} filePath
 * @param {{ limit?: number, open?: (filePath: string, flags: number) => Promise<import("node:fs/promises").FileHandle> }} [options]
 * @returns {Promise<{ fileName: string, bytes: Uint8Array } | { fileName: string, error: "tooLarge" | "unreadable" }>}
 */
async function readProjectFile(filePath, { limit = SKF_ARCHIVE_BYTE_LIMIT, open = (target, flags) => fs.promises.open(target, flags) } = {}) {
  const fileName = nodePath.basename(filePath);
  let handle;
  try {
    // Opening a FIFO or device for reading can block until something writes
    // to it, which would stall every file queued behind this one, so refuse
    // anything but a regular file before opening it. O_NONBLOCK keeps a path
    // swapped for a FIFO after this check from blocking the open; it does not
    // change reads from a regular file. Windows has neither and needs neither.
    if (!(await fs.promises.stat(filePath)).isFile()) return { fileName, error: "unreadable" };
    handle = await open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    if (!(await handle.stat()).isFile()) return { fileName, error: "unreadable" };
    const chunks = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > limit) return { fileName, error: "tooLarge" };
    // A Buffer is a Uint8Array, and IPC delivers it to the renderer as one.
    return { fileName, bytes: Buffer.concat(chunks, total) };
  } catch {
    return { fileName, error: "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Delivers project files to the page one at a time, in order, and only while
 * the page has subscribed. A file the OS hands over before the window has
 * loaded (macOS sends `open-file` before `ready`), or while the page reloads
 * during its read, stays queued until the next subscription. A file that
 * fails to read or send is dropped so the files behind it still open.
 *
 * @template File
 * @param {{ read: (filePath: string) => Promise<File>, send: (file: File) => boolean }} io
 *   `send` returns false when there is no window to take the file.
 */
function createProjectFileQueue({ read, send }) {
  const pending = [];
  let ready = false;
  let pumping = null;

  async function pump() {
    while (ready && pending.length) {
      const filePath = pending[0];
      let file;
      try {
        file = await read(filePath);
      } catch (error) {
        pending.shift();
        console.warn(`SketchForge could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      // The page may have reloaded while the file was read; keep it for the next one.
      if (!ready) return;
      let delivered = false;
      try {
        delivered = send(file);
      } catch (error) {
        console.warn(`SketchForge could not open ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        delivered = true;
      }
      if (!delivered) {
        // No window took it: wait for the next page to subscribe.
        ready = false;
        return;
      }
      pending.shift();
    }
  }

  function start() {
    if (pumping) return;
    pumping = pump().finally(() => {
      pumping = null;
      // A file added after the loop ended, but before this ran, still needs a pass.
      if (ready && pending.length) start();
    });
  }

  return {
    /** @param {readonly string[]} filePaths */
    add(filePaths) {
      for (const filePath of filePaths) {
        if (!pending.includes(filePath)) pending.push(filePath);
      }
      start();
    },
    rendererReady() {
      ready = true;
      start();
    },
    rendererGone() {
      ready = false;
    },
    /** Resolves once nothing is being read or sent. */
    async idle() {
      while (pumping) await pumping;
    },
  };
}

module.exports = { SKF_ARCHIVE_BYTE_LIMIT, createProjectFileQueue, readProjectFile, skfPathsFromArgv };
