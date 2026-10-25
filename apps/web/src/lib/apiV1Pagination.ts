const MAX_PAGE_SIZE = 1000;

export type ApiV1Page<T> = {
  items: T[];
  nextCursor: string | null;
};

/** Return a page using a base64url encoded offset cursor. */
export function paginateApiV1<T>(items: T[], rawLimit: string | undefined, rawCursor: string | undefined): ApiV1Page<T> | null {
  const offset = rawCursor === undefined ? 0 : decodeOffset(rawCursor);
  if (offset === null || offset > items.length) return null;

  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return null;
  }

  const end = limit === undefined ? items.length : Math.min(items.length, offset + limit);
  return {
    items: items.slice(offset, end),
    nextCursor: end < items.length ? Buffer.from(String(end)).toString("base64url") : null,
  };
}

function decodeOffset(cursor: string): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const offset = Number(decoded);
    return /^\d+$/.test(decoded) && Number.isSafeInteger(offset) && offset > 0
      && Buffer.from(String(offset)).toString("base64url") === cursor
      ? offset
      : null;
  } catch {
    return null;
  }
}
