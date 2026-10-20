/**
 * Standard screw threads, as data.
 *
 * Nobody wants to look up that an M8 is 1.25mm coarse pitch, and getting it
 * wrong produces a part that looks right and does not fit. These are the sizes
 * people actually reach for, with the pitch each designation implies.
 *
 * Metric pitches are ISO 261 coarse. Unified pitches are the coarse (UNC)
 * series, converted from threads per inch -- a 1/4-20 is 25.4/20 = 1.27mm.
 */

export type ThreadSeries = "metric" | "unified";

export type ThreadSize = {
  /** How the size is written: "M8", "1/4-20". */
  designation: string;
  series: ThreadSeries;
  /** Outside diameter of the male thread, in mm. */
  diameter: number;
  /** Axial rise per turn, in mm. */
  pitch: number;
};

function unified(designation: string, diameterInches: number, threadsPerInch: number): ThreadSize {
  return {
    designation,
    series: "unified",
    diameter: Number((diameterInches * 25.4).toFixed(3)),
    pitch: Number((25.4 / threadsPerInch).toFixed(3)),
  };
}

export const THREAD_SIZES: ThreadSize[] = [
  { designation: "M2", series: "metric", diameter: 2, pitch: 0.4 },
  { designation: "M2.5", series: "metric", diameter: 2.5, pitch: 0.45 },
  { designation: "M3", series: "metric", diameter: 3, pitch: 0.5 },
  { designation: "M4", series: "metric", diameter: 4, pitch: 0.7 },
  { designation: "M5", series: "metric", diameter: 5, pitch: 0.8 },
  { designation: "M6", series: "metric", diameter: 6, pitch: 1 },
  { designation: "M8", series: "metric", diameter: 8, pitch: 1.25 },
  { designation: "M10", series: "metric", diameter: 10, pitch: 1.5 },
  { designation: "M12", series: "metric", diameter: 12, pitch: 1.75 },
  { designation: "M16", series: "metric", diameter: 16, pitch: 2 },
  { designation: "M20", series: "metric", diameter: 20, pitch: 2.5 },
  unified("#4-40", 0.112, 40),
  unified("#6-32", 0.138, 32),
  unified("#8-32", 0.164, 32),
  unified("#10-24", 0.19, 24),
  unified("1/4-20", 0.25, 20),
  unified("5/16-18", 0.3125, 18),
  unified("3/8-16", 0.375, 16),
  unified("1/2-13", 0.5, 13),
];

export const DEFAULT_THREAD_SIZE = "M8";

/**
 * How much wider a tapped hole is cut than the bolt that goes in it.
 *
 * A hole cut at exactly the bolt's diameter does not accept the bolt: nothing
 * is left for the fit, and on a printed part nothing is left for the printer
 * either. A fifth of a millimetre is the usual starting point for FDM, and it
 * is a parameter rather than a constant because the right figure depends on
 * the machine.
 */
export const DEFAULT_HOLE_CLEARANCE = 0.2;

/** A size by its designation, case- and spacing-insensitive ("m8", "M 8"). */
export function threadSize(designation: string): ThreadSize | null {
  const wanted = designation.replace(/\s+/g, "").toLowerCase();
  return THREAD_SIZES.find((size) => size.designation.replace(/\s+/g, "").toLowerCase() === wanted) ?? null;
}

export function threadSizesInSeries(series: ThreadSeries) {
  return THREAD_SIZES.filter((size) => size.series === series);
}

/**
 * The thread as it should be built, male or female.
 *
 * A female thread is the same form cut larger, so the bolt it is meant for
 * still fits: the clearance is added to the diameter, which moves both the
 * crest and the root out by the same amount and leaves the profile's angle
 * alone.
 */
export function threadGeometry(size: ThreadSize, options: { hole?: boolean; clearance?: number } = {}) {
  const clearance = options.hole
    ? Math.max(0, options.clearance ?? DEFAULT_HOLE_CLEARANCE)
    : 0;
  return {
    designation: size.designation,
    diameter: size.diameter + clearance * 2,
    pitch: size.pitch,
    hole: Boolean(options.hole),
    clearance,
  };
}

/**
 * How far the thread's root is sunk into the core.
 *
 * The two have to overlap rather than meet: a root sitting exactly on the
 * core's surface shares a face with it, and the union comes back with hundreds
 * of slivers where a bolt should be one clean solid. A tenth of the thread's
 * depth is enough, capped so a coarse thread does not lose a visible bite.
 */
export function coreOverlapForPitch(pitch: number) {
  const threadDepth = Math.max(1e-4, 0.613 * pitch);
  return Math.min(0.05, threadDepth * 0.1);
}

/**
 * The core a thread of this form needs.
 *
 * A bolt's shank is its root diameter -- the thread stands out from it -- and a
 * tapped hole's drill is the same circle, which is why both forms take the
 * same core.
 */
export function threadCoreRadius(diameter: number, pitch: number) {
  const crest = Math.max(0.05, diameter / 2);
  return Math.max(0.01, crest - 0.613 * pitch);
}

/** How many turns covers a given length of thread, at least one. */
export function threadTurnsForLength(pitch: number, length: number) {
  if (!Number.isFinite(pitch) || pitch <= 0) return 1;
  return Math.max(1, Math.round((length / pitch) * 10) / 10);
}
