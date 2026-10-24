import type { NextConfig } from "next";
import path from "node:path";

export function resolveStaticExportBasePath(environment: Record<string, string | undefined>): string | undefined {
  if (environment.STATIC_EXPORT !== "true") return undefined;

  const basePath = environment.STATIC_EXPORT_BASE_PATH?.trim();
  if (!basePath) return undefined;

  if (
    !basePath.startsWith("/")
    || basePath === "/"
    || basePath.startsWith("//")
    || basePath.endsWith("/")
    || basePath.includes("//")
    || /[\\?#]/.test(basePath)
  ) {
    throw new Error("STATIC_EXPORT_BASE_PATH must be a path like /SketchForge-3D/Demo without a trailing slash.");
  }

  return basePath;
}

const isStaticExport = process.env.STATIC_EXPORT === "true";
const isDockerBuild = process.env.SKETCHFORGE_DOCKER_BUILD === "true";
const staticExportBasePath = resolveStaticExportBasePath(process.env);
const extraAllowedDevOrigins = (process.env.SKETCHFORGE_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(process.cwd()),
  devIndicators: false,
  // Keep the live development compiler isolated from `next build`. Sharing
  // `.next` lets a production verification build invalidate chunks used by a
  // running dev server, which also breaks API routes such as project snapshots.
  distDir: isStaticExport ? ".next-export" : process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  allowedDevOrigins: ["localhost", "127.0.0.1", ...extraAllowedDevOrigins],
  env: {
    NEXT_PUBLIC_STATIC_EXPORT: isStaticExport ? "true" : "false",
    NEXT_PUBLIC_STATIC_EXPORT_BASE_PATH: staticExportBasePath ?? "",
  },
  images: {
    unoptimized: true
  },
  // The OCCT kernel and manifold both run server-side for the REST API -- OCCT
  // for fillet and chamfer, manifold for revolves and threads (upstream #55).
  // Their Emscripten glue loads its own .wasm with `createRequire`, which does
  // not survive bundling: the bundled copy fails at runtime with
  // "createRequire is not a function". Node must require them from node_modules
  // instead.
  serverExternalPackages: ["occt-wasm", "manifold-3d"],
  // brepjs (loaded lazily by the STEP exporter) ships an auto-init helper that
  // tries optional kernel backends via guarded `import().catch()`. We only install
  // and use occt-wasm, so silence the resolution warnings for the backends we omit.
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "brepkit-wasm": false,
      "brepjs-opencascade": false,
    };
    return config;
  },
  ...(isStaticExport
    ? {
        output: "export" as const,
        trailingSlash: true,
        ...(staticExportBasePath ? { basePath: staticExportBasePath } : {}),
      }
    : isDockerBuild
      ? { output: "standalone" as const }
      : {}),
};

export default nextConfig;
