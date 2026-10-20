// Counts how many full project writes a burst of edits costs.
//
// Autosave used to chain one write per edit; the queue in lib/saveQueue.ts
// keeps only the newest waiting job, so a burst should cost the write already
// in flight plus one -- not one per edit. Counts both storage backends: the
// IndexedDB put for browser storage and the POST for server storage.
//
// Expected: writes <= 2 for a burst of 8 edits, and the last write must carry
// the final position (a coalescing bug that drops the *newest* job instead of
// the obsolete ones would still show a low count, so check the value too).
//
// Exported by assignment rather than left as a bare expression: the harness
// evaluates this file to get the function, and an assignment evaluates to the
// value assigned, so both a `require` and an `eval` yield the same thing.
module.exports = async (page) => {
  await page.reload();
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__autosaveWrites = 0;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "projectShapes" && value?.skfPackage) window.__autosaveWrites += 1;
      return originalPut.call(this, value, ...args);
    };
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url ?? "";
      const method = (init?.method ?? (typeof input === "object" ? input?.method : "GET") ?? "GET").toUpperCase();
      if (url.includes("/api/projects") && method === "POST") window.__autosaveWrites += 1;
      return originalFetch.call(this, input, init);
    };
  });

  const state = async () => JSON.parse(await page.locator("[data-codex-state]").textContent());
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(400);
  const before = await state();

  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(60);
  }
  // Long enough for the write in flight and the one queued behind it.
  await page.waitForTimeout(4000);

  const after = await state();
  const writes = await page.evaluate(() => window.__autosaveWrites);
  return { writes, movedBy: after.shapes?.[0]?.x - before.shapes?.[0]?.x, before, after };
};
