import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import webProcessModule from "../../apps/desktop/webProcess.cjs";

const { createUpdateInstaller, singleFlight, stopProcess, watchProcess } = webProcessModule;

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

function node(script: string) {
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}

function firstLine(child: ChildProcess) {
  return new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
}

describe("watchProcess", () => {
  it("settles on close, after the output streams end, not on exit", async () => {
    // Node emits `exit` before the stdio streams drain, so the final stderr chunk
    // (where EADDRINUSE is reported) can arrive after it.
    const child = Object.assign(new EventEmitter(), { pid: 1234 }) as unknown as ChildProcess;
    const watch = watchProcess(child);
    let settled = false;
    void watch.closed.then(() => { settled = true; });
    child.emit("exit", 1, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(watch.isClosed()).toBe(false);
    child.emit("close", 1, null);
    await watch.closed;
    expect(watch.isClosed()).toBe(true);
  });

  it("has seen all of a real process's output once it settles", async () => {
    const child = node("process.stderr.write('x'.repeat(1 << 20) + ' EADDRINUSE'); process.exitCode = 1;");
    let output = "";
    child.stderr!.on("data", (chunk) => { output += String(chunk); });
    await watchProcess(child).closed;
    expect(output.endsWith("EADDRINUSE")).toBe(true);
  });

  it("settles when the process could not be spawned at all", async () => {
    const child = spawn("sketchforge-command-that-does-not-exist", [], { stdio: "ignore" });
    child.on("error", () => {});
    await watchProcess(child).closed;
  });
});

describe("stopProcess", () => {
  it("resolves once the process has exited", async () => {
    const child = node("setInterval(() => {}, 1000); console.log('ready');");
    await firstLine(child);
    const watch = watchProcess(child);
    await stopProcess(child, watch, { graceMs: 5_000 });
    expect(watch.isClosed()).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("forces a process that ignores the polite signal", async () => {
    const child = node("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');");
    await firstLine(child);
    const watch = watchProcess(child);
    await stopProcess(child, watch, { graceMs: 300 });
    expect(watch.isClosed()).toBe(true);
  });

  it("returns at once for a process that already closed", async () => {
    const child = node("");
    const watch = watchProcess(child);
    await watch.closed;
    await stopProcess(child, watch);
  });
});

describe("createUpdateInstaller", () => {
  function setup({ stopFails = false } = {}) {
    const calls: string[] = [];
    let finishStop!: () => void;
    const installer = createUpdateInstaller({
      stop: () => new Promise<void>((resolve, reject) => {
        calls.push("stop");
        finishStop = stopFails ? () => reject(new Error("stop failed")) : resolve;
      }),
      install: () => { calls.push("install"); },
    });
    return { installer, calls, finishStop: () => finishStop() };
  }

  it("is in progress from the moment it starts, and installs only after the web process stopped", async () => {
    const { installer, calls, finishStop } = setup();
    expect(installer.isInProgress()).toBe(false);
    const started = installer.start();
    expect(installer.isInProgress()).toBe(true);
    expect(calls).toEqual(["stop"]);
    finishStop();
    expect(await started).toBe(true);
    expect(calls).toEqual(["stop", "install"]);
    // Still in progress: the installer quits the app when it succeeds.
    expect(installer.isInProgress()).toBe(true);
  });

  it("ignores a second start while one is in progress", async () => {
    const { installer, calls, finishStop } = setup();
    const first = installer.start();
    expect(await installer.start()).toBe(false);
    finishStop();
    await first;
    expect(calls).toEqual(["stop", "install"]);
  });

  it("can start again after the install failed", async () => {
    const { installer, calls, finishStop } = setup();
    const first = installer.start();
    finishStop();
    await first;
    installer.failed();
    expect(installer.isInProgress()).toBe(false);
    const second = installer.start();
    finishStop();
    expect(await second).toBe(true);
    expect(calls).toEqual(["stop", "install", "stop", "install"]);
  });

  it("is no longer in progress when stopping the web process throws", async () => {
    const { installer, calls, finishStop } = setup({ stopFails: true });
    const started = installer.start();
    finishStop();
    await expect(started).rejects.toThrow("stop failed");
    expect(installer.isInProgress()).toBe(false);
    expect(calls).toEqual(["stop"]);
  });
});

describe("singleFlight", () => {
  it("shares one run between overlapping calls and runs again once it settles", async () => {
    let runs = 0;
    let release!: () => void;
    const start = singleFlight(() => {
      runs += 1;
      return new Promise<number>((resolve) => { release = () => resolve(runs); });
    });
    const first = start();
    const second = start();
    expect(runs).toBe(1);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    const third = start();
    expect(runs).toBe(2);
    release();
    expect(await third).toBe(2);
  });

  it("runs again after a failed run", async () => {
    let runs = 0;
    const start = singleFlight(async () => {
      runs += 1;
      if (runs === 1) throw new Error("first start failed");
      return runs;
    });
    await expect(start()).rejects.toThrow("first start failed");
    expect(await start()).toBe(2);
  });
});
