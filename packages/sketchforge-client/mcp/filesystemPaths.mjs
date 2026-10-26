import { existsSync, lstatSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

function configuredRoot() {
  return process.env.SKETCHFORGE_MCP_FILES_DIR || process.env.SKETCHFORGE_PROJECTS_DIR;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function getRoot() {
  const configured = configuredRoot();
  if (!configured) return undefined;
  const requestedRoot = path.resolve(configured);
  await mkdir(requestedRoot, { recursive: true });
  return realpath(requestedRoot);
}

async function resolveThroughExistingAncestor(requested) {
  let candidate = requested;
  const suffix = [];
  while (true) {
    try {
      return path.join(await realpath(candidate), ...suffix);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
      if (candidate === path.dirname(candidate)) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = path.dirname(candidate);
    }
  }
}

function requireWithin(root, target) {
  if (!isWithin(root, target)) throw new Error(`Path is outside the configured MCP files root: ${root}`);
  return target;
}

export async function resolveMcpReadPath(value) {
  const requested = path.resolve(String(value ?? ""));
  const root = await getRoot();
  const resolved = await realpath(requested);
  return root ? requireWithin(root, resolved) : resolved;
}

export async function resolveMcpWritePath(value, { overwrite = false } = {}) {
  const requested = path.resolve(String(value ?? ""));
  const root = await getRoot();
  let resolved;
  if (existsSync(requested)) {
    resolved = await realpath(requested);
    if (root) requireWithin(root, resolved);
    if (!overwrite) throw new Error(`Output file already exists; set overwrite: true to replace it: ${requested}`);
  } else {
    try {
      if (lstatSync(requested).isSymbolicLink()) throw new Error(`Cannot write through a dangling output symlink: ${requested}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    resolved = await resolveThroughExistingAncestor(requested);
  }
  const destination = root ? requireWithin(root, resolved) : resolved;
  await mkdir(path.dirname(destination), { recursive: true });
  return destination;
}
