import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { load as loadYaml } from "js-yaml";
import projectFilesModule from "../../apps/desktop/projectFiles.cjs";
import { SKF_LIMITS, SKF_MEDIA_TYPE } from "@/lib/engine/skfProject";

const { createProjectFileQueue, readProjectFile, SKF_ARCHIVE_BYTE_LIMIT, skfPathsFromArgv } = projectFilesModule;

const desktopDir = path.resolve(__dirname, "..", "..", "apps", "desktop");

describe("skfPathsFromArgv", () => {
  // Each platform's rules are passed explicitly, so these hold on any host.
  const posix = { pathApi: path.posix };
  const win32 = { pathApi: path.win32 };

  describe("with POSIX paths (macOS and Linux)", () => {
    it("takes .skf paths from a packaged launch and ignores the executable", () => {
      expect(skfPathsFromArgv(["/Applications/SketchForge.app/Contents/MacOS/SketchForge", "/Users/a/Bracket.skf"], "/", posix))
        .toEqual(["/Users/a/Bracket.skf"]);
    });

    it("skips the dev main script, Chromium switches, and files that are not projects", () => {
      const argv = [
        "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        "/repo/apps/desktop/main.cjs",
        "--inspect=9229",
        "--allow-file-access-from-files",
        "--original-process-start-time=13371337",
        "-psn_0_12345",
        "--",
        "/models/part.stl",
        "/models/notes.txt",
        "/models/Assembly.SKF",
        "/models/flag-like.skf.bak",
      ];
      expect(skfPathsFromArgv(argv, "/repo", posix)).toEqual(["/models/Assembly.SKF"]);
    });

    it("resolves relative paths against the launching directory", () => {
      expect(skfPathsFromArgv(["sketchforge", "parts/bracket.skf", "./lid.skf"], "/home/a/projects", posix))
        .toEqual(["/home/a/projects/parts/bracket.skf", "/home/a/projects/lid.skf"]);
    });

    it("accepts file:// URIs, which Linux desktop entries pass for %U", () => {
      expect(skfPathsFromArgv(["sketchforge", "file:///home/a/My%20Part.skf"], "/", posix))
        .toEqual(["/home/a/My Part.skf"]);
    });

    it("drops duplicates and non-string or empty arguments", () => {
      const argv = ["sketchforge", "/a/x.skf", "", "/a/../a/x.skf", 42 as unknown as string, "http://example.com/x.skf"];
      expect(skfPathsFromArgv(argv, "/", posix)).toEqual(["/a/x.skf"]);
    });
  });

  describe("with Windows paths", () => {
    it("takes drive paths and skips the executable, switches, and files that are not projects", () => {
      const argv = [
        "C:\\Program Files\\SketchForge\\SketchForge.exe",
        "--allow-file-access-from-files",
        "C:\\Users\\a\\Desktop\\Bracket.skf",
        "C:\\Users\\a\\Desktop\\notes.txt",
      ];
      expect(skfPathsFromArgv(argv, "C:\\", win32)).toEqual(["C:\\Users\\a\\Desktop\\Bracket.skf"]);
    });

    it("resolves relative paths against a drive working directory", () => {
      expect(skfPathsFromArgv(["SketchForge.exe", "Lid.skf", "parts\\Bracket.skf", "..\\Box.skf"], "C:\\work\\designs", win32))
        .toEqual(["C:\\work\\designs\\Lid.skf", "C:\\work\\designs\\parts\\Bracket.skf", "C:\\work\\Box.skf"]);
    });

    it("keeps UNC paths to network shares", () => {
      expect(skfPathsFromArgv(["SketchForge.exe", "\\\\fileserver\\share\\Bracket.skf"], "C:\\", win32))
        .toEqual(["\\\\fileserver\\share\\Bracket.skf"]);
    });

    it("accepts file:///C:/ URIs as drive paths", () => {
      expect(skfPathsFromArgv(["SketchForge.exe", "file:///C:/Users/a/My%20Part.skf"], "C:\\", win32))
        .toEqual(["C:\\Users\\a\\My Part.skf"]);
    });

    it("drops a duplicate spelled with forward slashes or a .. segment", () => {
      expect(skfPathsFromArgv(["SketchForge.exe", "C:\\a\\x.skf", "C:/a/x.skf", "C:\\a\\b\\..\\x.skf"], "C:\\", win32))
        .toEqual(["C:\\a\\x.skf"]);
    });
  });

  it("uses the host's path rules by default", () => {
    const cwd = process.cwd();
    expect(skfPathsFromArgv(["sketchforge", "Bracket.skf"], cwd)).toEqual([path.resolve(cwd, "Bracket.skf")]);
  });

  it("returns nothing for a missing argv", () => {
    expect(skfPathsFromArgv(undefined, "/")).toEqual([]);
  });
});

describe("createProjectFileQueue", () => {
  function harness(read: (filePath: string) => Promise<unknown> = async (filePath) => ({ filePath })) {
    const sent: unknown[] = [];
    const send = vi.fn((file: unknown) => {
      sent.push(file);
      return true;
    });
    const queue = createProjectFileQueue({ read: vi.fn(read), send });
    return { queue, sent, send };
  }

  it("holds files until the page is listening, then delivers them once each, in order", async () => {
    const { queue, sent } = harness();
    queue.add(["/a/one.skf"]);
    queue.add(["/a/two.skf", "/a/one.skf"]);
    await queue.idle();
    expect(sent).toEqual([]);
    queue.rendererReady();
    await queue.idle();
    expect(sent).toEqual([{ filePath: "/a/one.skf" }, { filePath: "/a/two.skf" }]);
  });

  it("delivers immediately while the page is listening", async () => {
    const { queue, sent } = harness();
    queue.rendererReady();
    queue.add(["/a/three.skf"]);
    await queue.idle();
    expect(sent).toEqual([{ filePath: "/a/three.skf" }]);
  });

  it("delivers a file added after a pass has emptied the queue but before that pass has settled", async () => {
    const sent: unknown[] = [];
    const queue = createProjectFileQueue({
      read: async (filePath: string) => ({ filePath }),
      send: (file: { filePath: string }) => {
        sent.push(file);
        // Queued now, this runs after the pass leaves its loop with the queue
        // empty but before the pass has settled.
        if (file.filePath === "/a/first.skf") queueMicrotask(() => queue.add(["/a/late.skf"]));
        return true;
      },
    });
    queue.add(["/a/first.skf"]);
    queue.rendererReady();
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 1000 });
    await queue.idle();
    expect(sent).toEqual([{ filePath: "/a/first.skf" }, { filePath: "/a/late.skf" }]);
  });

  it("holds files again after the page stops listening, as on a reload", async () => {
    const { queue, sent } = harness();
    queue.rendererReady();
    queue.rendererGone();
    queue.add(["/a/four.skf"]);
    await queue.idle();
    expect(sent).toEqual([]);
    queue.rendererReady();
    queue.rendererReady();
    await queue.idle();
    expect(sent).toEqual([{ filePath: "/a/four.skf" }]);
  });

  it("keeps a file the page stopped listening for while it was being read", async () => {
    let finishRead: () => void = () => undefined;
    let readsStarted = 0;
    const { queue, sent } = harness((filePath) => new Promise((resolve) => {
      readsStarted += 1;
      finishRead = () => resolve({ filePath });
    }));
    queue.add(["/a/reloaded.skf"]);
    queue.rendererReady();
    // The read has started; the page reloads before it finishes.
    await vi.waitFor(() => expect(readsStarted).toBe(1));
    queue.rendererGone();
    finishRead();
    await queue.idle();
    expect(sent).toEqual([]);
    queue.rendererReady();
    finishRead();
    await queue.idle();
    expect(sent).toEqual([{ filePath: "/a/reloaded.skf" }]);
  });

  it("keeps a file the window could not take, and delivers it on the next subscription", async () => {
    const sent: unknown[] = [];
    let windowOpen = false;
    const queue = createProjectFileQueue({
      read: async (filePath: string) => ({ filePath }),
      send: (file: unknown) => {
        if (!windowOpen) return false;
        sent.push(file);
        return true;
      },
    });
    queue.rendererReady();
    queue.add(["/a/closed.skf"]);
    await queue.idle();
    expect(sent).toEqual([]);
    windowOpen = true;
    queue.rendererReady();
    await queue.idle();
    expect(sent).toEqual([{ filePath: "/a/closed.skf" }]);
  });

  it("keeps delivering after one file fails to read or send", async () => {
    const sent: unknown[] = [];
    const queue = createProjectFileQueue({
      read: async (filePath: string) => {
        if (filePath.includes("bad-read")) throw new Error("read failed");
        return { filePath };
      },
      send: (file: { filePath: string }) => {
        if (file.filePath.includes("bad-send")) throw new Error("send failed");
        sent.push(file);
        return true;
      },
    });
    queue.rendererReady();
    queue.add(["/a/bad-read.skf", "/a/bad-send.skf", "/a/good.skf"]);
    await queue.idle();
    expect(sent).toEqual([{ filePath: "/a/good.skf" }]);
  });
});

describe("readProjectFile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sketchforge-desktop-read-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns the file's bytes and name", async () => {
    const filePath = path.join(dir, "Bracket.skf");
    fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));
    const file = await readProjectFile(filePath, { limit: 4 });
    expect(file).toEqual({ fileName: "Bracket.skf", bytes: Buffer.from([1, 2, 3, 4]) });
    expect("bytes" in file && file.bytes).toBeInstanceOf(Uint8Array);
  });

  it("refuses a file one byte over the limit without returning its bytes", async () => {
    const filePath = path.join(dir, "Huge.skf");
    fs.writeFileSync(filePath, Buffer.alloc(5, 7));
    expect(await readProjectFile(filePath, { limit: 4 })).toEqual({ fileName: "Huge.skf", error: "tooLarge" });
  });

  it("stops reading past the limit, so a huge file is never loaded whole", async () => {
    const filePath = path.join(dir, "Bigger.skf");
    fs.writeFileSync(filePath, Buffer.alloc(3 * 1024 * 1024, 1));
    let bytesRead = 0;
    const open = async (target: string, flags: number) => {
      const handle = await fs.promises.open(target, flags);
      const read = handle.read.bind(handle);
      return Object.assign(handle, {
        read: async (...args: Parameters<typeof read>) => {
          const result = await read(...args);
          bytesRead += result.bytesRead;
          return result;
        },
      });
    };
    expect(await readProjectFile(filePath, { limit: 1024, open })).toEqual({ fileName: "Bigger.skf", error: "tooLarge" });
    expect(bytesRead).toBe(1025);
  });

  it("reports a missing file or a directory as unreadable", async () => {
    expect(await readProjectFile(path.join(dir, "Missing.skf"))).toEqual({ fileName: "Missing.skf", error: "unreadable" });
    const folder = path.join(dir, "Folder.skf");
    fs.mkdirSync(folder);
    expect(await readProjectFile(folder)).toEqual({ fileName: "Folder.skf", error: "unreadable" });
  });

  it("refuses anything but a regular file before opening it", async () => {
    const folder = path.join(dir, "NotAFile.skf");
    fs.mkdirSync(folder);
    const open = vi.fn();
    expect(await readProjectFile(folder, { open: open as never })).toEqual({ fileName: "NotAFile.skf", error: "unreadable" });
    expect(open).not.toHaveBeenCalled();
  });

  // Opening a FIFO for reading blocks until a writer appears, which would
  // stall every file queued behind it. Windows has no FIFOs in the file system.
  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("refuses a FIFO named .skf without blocking, and still delivers the file behind it", async () => {
    const fifo = path.join(dir, "Pipe.skf");
    execFileSync("mkfifo", [fifo]);
    const after = path.join(dir, "AfterPipe.skf");
    fs.writeFileSync(after, Buffer.from([9, 8]));
    const sent: unknown[] = [];
    const queue = createProjectFileQueue({
      read: (filePath: string) => readProjectFile(filePath),
      send: (file: unknown) => {
        sent.push(file);
        return true;
      },
    });
    queue.add([fifo, after]);
    queue.rendererReady();
    try {
      const outcome = await Promise.race([
        queue.idle().then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000)),
      ]);
      expect(outcome).toBe("settled");
    } finally {
      // Release a reader stuck in open(2), so a failure cannot hang the worker.
      try {
        fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      } catch {
        // No reader was waiting.
      }
    }
    expect(sent).toEqual([
      { fileName: "Pipe.skf", error: "unreadable" },
      { fileName: "AfterPipe.skf", bytes: Buffer.from([9, 8]) },
    ]);
  });

  describe("closes the handle on every outcome", () => {
    const regular = path.join(dir, "Handle.skf");
    fs.writeFileSync(regular, Buffer.from([0]));

    function fakeOpen({ isFile = true, chunks = [] as number[][], readError = false } = {}) {
      const close = vi.fn(async () => undefined);
      let next = 0;
      const open = vi.fn(async () => ({
        stat: async () => ({ isFile: () => isFile }),
        read: async (buffer: Buffer) => {
          if (readError) throw new Error("EIO");
          const chunk = (chunks[next++] ?? []).slice(0, buffer.length);
          buffer.set(chunk);
          return { bytesRead: chunk.length, buffer };
        },
        close,
      }));
      return { open: open as never, close };
    }

    it("after a successful read", async () => {
      const { open, close } = fakeOpen({ chunks: [[1, 2]] });
      expect(await readProjectFile(regular, { limit: 4, open })).toEqual({ fileName: "Handle.skf", bytes: Buffer.from([1, 2]) });
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("after refusing a file over the limit", async () => {
      const { open, close } = fakeOpen({ chunks: [[1, 2, 3, 4, 5]] });
      expect(await readProjectFile(regular, { limit: 4, open })).toEqual({ fileName: "Handle.skf", error: "tooLarge" });
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("after the open handle turns out not to be a file", async () => {
      const { open, close } = fakeOpen({ isFile: false });
      expect(await readProjectFile(regular, { limit: 4, open })).toEqual({ fileName: "Handle.skf", error: "unreadable" });
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("after a read error", async () => {
      const { open, close } = fakeOpen({ readError: true });
      expect(await readProjectFile(regular, { limit: 4, open })).toEqual({ fileName: "Handle.skf", error: "unreadable" });
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});

describe("desktop .skf packaging", () => {
  const config = loadYaml(fs.readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8")) as {
    files: string[];
    fileAssociations?: Array<{ ext: string; mimeType?: string; role?: string }>;
  };

  it("registers .skf with the engine's media type", () => {
    const skf = config.fileAssociations?.find((association) => association.ext === "skf");
    expect(skf).toBeDefined();
    expect(skf?.mimeType).toBe(SKF_MEDIA_TYPE);
    expect(skf?.role).toBe("Editor");
  });

  it("caps the file read at the engine's archive limit", () => {
    expect(SKF_ARCHIVE_BYTE_LIMIT).toBe(SKF_LIMITS.archiveBytes);
  });

  it("packages every local module the main process and preload require", () => {
    for (const entry of ["main.cjs", "preload.cjs"]) {
      const source = fs.readFileSync(path.join(desktopDir, entry), "utf8");
      const required = [...source.matchAll(/require\("\.\/([^"]+)"\)/g)].map((match) => `apps/desktop/${match[1]}`);
      for (const file of required) expect(config.files).toContain(file);
    }
  });
});
