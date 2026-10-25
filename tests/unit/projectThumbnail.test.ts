import { describe, expect, it, vi } from "vitest";
import {
  captureProjectThumbnail,
  projectThumbnailDimensions,
  projectThumbnailPngDataUrl,
  projectThumbnailSceneChanged,
} from "@/lib/projectThumbnail";

describe("project thumbnails", () => {
  it("reduces a high-DPI editor canvas to the thumbnail bounds", () => {
    expect(projectThumbnailDimensions(2048, 992)).toEqual({ width: 512, height: 248 });
    expect(projectThumbnailDimensions(800, 1200)).toEqual({ width: 213, height: 320 });
    expect(projectThumbnailDimensions(320, 180)).toEqual({ width: 320, height: 180 });
  });

  it("captures only changed scenes within the same project", () => {
    const original = { projectId: "project-1", fingerprint: "scene-a" };
    expect(projectThumbnailSceneChanged(null, original)).toBe(false);
    expect(projectThumbnailSceneChanged(original, original)).toBe(false);
    expect(projectThumbnailSceneChanged(original, { ...original, fingerprint: "scene-b" })).toBe(true);
    expect(projectThumbnailSceneChanged(original, { projectId: "project-2", fingerprint: "scene-b" })).toBe(false);
  });

  it("turns rejected captures into an empty thumbnail and allows the next idle capture to retry", async () => {
    const failure = new Error("WebGL context lost");
    const capture = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("data:image/png;base64,thumbnail");
    const onError = vi.fn();

    await expect(captureProjectThumbnail(capture, onError)).resolves.toBe("");
    await expect(captureProjectThumbnail(capture, onError)).resolves.toBe("data:image/png;base64,thumbnail");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("returns an empty PNG for a zero-size canvas or a lost drawing context", async () => {
    const makeDocument = (context: { drawImage: () => void } | null) => ({
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => context,
        toBlob: (callback: (blob: Blob | null) => void) => callback(null),
      }),
    }) as unknown as Document;

    await expect(projectThumbnailPngDataUrl({ width: 0, height: 20 } as HTMLCanvasElement, makeDocument({ drawImage: vi.fn() }))).resolves.toBe("");
    await expect(projectThumbnailPngDataUrl({ width: 20, height: 20 } as HTMLCanvasElement, makeDocument(null))).resolves.toBe("");
    await expect(projectThumbnailPngDataUrl({ width: 20, height: 20 } as HTMLCanvasElement, makeDocument({ drawImage: () => { throw new Error("context lost"); } }))).resolves.toBe("");
  });
});
