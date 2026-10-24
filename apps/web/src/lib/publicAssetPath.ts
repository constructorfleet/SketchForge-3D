/** Prefix app-owned root paths when the app is hosted below a URL path. */
export function withAppBasePath(
  path: string,
  basePath = process.env.NEXT_PUBLIC_STATIC_EXPORT_BASE_PATH ?? "",
): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  return `${basePath}${path}`;
}

/** Prefix root-relative public assets when the app is hosted below a URL path. */
export function publicAssetPath(path: string, basePath?: string): string {
  return withAppBasePath(path, basePath);
}
