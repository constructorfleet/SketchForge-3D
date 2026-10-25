export const PROJECT_THUMBNAIL_IDLE_MS = 2_500;
export const PROJECT_THUMBNAIL_MAX_WIDTH = 512;
export const PROJECT_THUMBNAIL_MAX_HEIGHT = 320;

export async function captureProjectThumbnail(
  capture: () => Promise<string>,
  onError: (error: unknown) => void,
): Promise<string> {
  try {
    return await capture();
  } catch (error) {
    try {
      onError(error);
    } catch {
      // Error reporting must not turn a failed thumbnail into an unhandled rejection.
    }
    return "";
  }
}

export function projectThumbnailPngDataUrl(source: HTMLCanvasElement, documentRef: Document = document) {
  if (source.width <= 0 || source.height <= 0) return Promise.resolve("");
  const dimensions = projectThumbnailDimensions(source.width, source.height);
  try {
    const thumbnail = documentRef.createElement("canvas");
    thumbnail.width = dimensions.width;
    thumbnail.height = dimensions.height;
    const context = thumbnail.getContext("2d", { alpha: false });
    if (!context) return Promise.resolve("");
    context.drawImage(source, 0, 0, dimensions.width, dimensions.height);
    return new Promise<string>((resolve) => {
      thumbnail.toBlob((blob) => {
        if (!blob) {
          resolve("");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      }, "image/png");
    }).catch(() => "");
  } catch {
    return Promise.resolve("");
  }
}

export type ProjectThumbnailSceneKey = {
  projectId: string;
  fingerprint: string;
};

export function projectThumbnailDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth = PROJECT_THUMBNAIL_MAX_WIDTH,
  maxHeight = PROJECT_THUMBNAIL_MAX_HEIGHT,
) {
  const width = Math.max(1, Math.round(Number.isFinite(sourceWidth) ? sourceWidth : 1));
  const height = Math.max(1, Math.round(Number.isFinite(sourceHeight) ? sourceHeight : 1));
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function projectThumbnailSceneChanged(
  previous: ProjectThumbnailSceneKey | null,
  current: ProjectThumbnailSceneKey,
) {
  return previous?.projectId === current.projectId && previous.fingerprint !== current.fingerprint;
}
