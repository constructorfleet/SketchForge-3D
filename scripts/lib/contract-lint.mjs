// Lints acceptance-criteria contracts. A contract opts in by declaring
// `verified_delivery: contract` in its frontmatter; every other document is
// ignored, so marking a document is the deliberate act that subjects it to
// these rules. See constructorfleet/SketchForge-3D#220 for the specification
// and #171 for why the severities are split the way they are.

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const MARKER = /^\s*verified_delivery\s*:\s*contract\s*$/m;

/** @returns {boolean} whether the source declares itself a contract. */
export function isContract(source) {
  const frontmatter = FRONTMATTER.exec(source);
  return frontmatter !== null && MARKER.test(frontmatter[1]);
}

// A contract is one phase's acceptance contract. Phase ordering across phases
// is the order of their sections in the document, per #172, so no parent or
// prerequisite references are carried here.
const REQUIRED_SECTIONS = [
  "Objective",
  "Acceptance Criteria",
  "Negative Requirements",
  "Verification Requirements",
  "Completion Authority",
];

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function sectionBody(source, heading) {
  const start = sectionIndex(source, heading);
  if (start === -1) return "";
  const after = source.slice(start);
  const next = /\n##[ \t]/.exec(after.slice(1));
  return next ? after.slice(0, next.index + 1) : after;
}

function sectionIndex(source, heading) {
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "m");
  const match = pattern.exec(source);
  return match ? match.index : -1;
}

const CLASSES = ["automated", "human", "hardware"];
const OBLIGATIONS = ["required", "optional"];
const KINDS = ["verify", "assert"];
const TIERS = ["blackbox", "whitebox"];
// A superseded criterion stays in the contract marked retired rather than being
// deleted, so its identifier is never reused and the contract records what was
// once required (#172). A retired criterion is history, not a live requirement,
// so the wording and marking rules do not apply to it.
const RETIRED = "retired";

// Configuration, not logic: extend this when a new piece of vagueness turns up
// in practice. Ordered longest-first so the most specific phrase is reported.
export const BANNED_PREDICATES = [
  "works correctly",
  "correct behavior",
  "as expected",
  "where applicable",
  "handles errors",
  "no regressions",
  "user-friendly",
  "appropriately",
  "performant",
  "gracefully",
  "reasonable",
  "if needed",
  "intuitive",
  "scalable",
  "efficient",
  "sensible",
  "properly",
  "robust",
  "works",
  "clean",
  "fast",
  "slow",
].sort((a, b) => b.length - a.length);

// A claim about speed, scale or capacity is unverifiable without a quantity, so
// one of these words obliges the criterion to carry a number.
const QUANTIFIABLE = /\b(responsive|responsiveness|latency|throughput|concurrent(?:ly)?|scales?|scaling|speed|per second|under load|simultaneous(?:ly)?)\b/i;
const PLACEHOLDERS = /\b(TBD|TODO|\?\?\?|etc\.|and so on)\b/i;

const NEGATIVE_REQUIREMENT = /^###[ \t]+(NR-\d{3})[ \t]*:/m;
const EXPLICITLY_NONE = /^\s*none\.?\s*$/im;
const TIER_JUSTIFICATION = /tier justification\s*:/i;
const NAMED_REVIEWER = /reviewer\s*:/i;
// A contract of nothing but success paths has not been thought through; at
// least one criterion must concern a failure, boundary or refusal.
const FAILURE_PATH = /\b(error|errors|fails?|failure|rejects?|rejected|refuses?|invalid|missing|empty|cancelled|canceled|killed|denied|denies|times? out|cannot|does not|do not|never)\b/i;

// Warn-tier patterns. These judge wording rather than presence, so their
// false-positive rate is unmeasured and they must never block (#171). Promotion
// waits on roughly twenty real criteria to calibrate against.
const QUANTIFIERS = /\b(never|always|all|any|every)\b/i;
const MIN_CRITERION_WORDS = 8;
const MAX_CRITERION_WORDS = 60;
const IMPLEMENTATION_SYMBOL =
  /(`[^`]*\.(?:ts|tsx|mjs|js|py|json|ya?ml|md)`|\b[a-z]+[A-Z][A-Za-z]*\b|\b[a-z]+_[a-z]+\b|`[^`]+\(\)`)/;
const OBSERVABLE_VERB =
  /\b(is|are|was|were|returns?|yields?|produces?|contains?|appears?|shows?|reports?|logs?|stays?|remains?|equals?|matches?|has|have|receives?|observes?|leaves?|terminates?|continues?|accepts?|rejects?|fails?|succeeds?|assigned|created|listed|raised|surfaces?|emits?|writes?|reads?|blocks?|allows?|prevents?|denies|denied|leaks?|shares?)\b/i;

const CRITERION_HEADING = /^###[ \t]+(AC-\d{3})[ \t]*:[ \t]*(.+?)[ \t]*$/gm;

function parseCriteria(source) {
  const criteria = [];
  CRITERION_HEADING.lastIndex = 0;
  let match;
  while ((match = CRITERION_HEADING.exec(source)) !== null) {
    const [heading, id, title] = match;
    const markings = /\(([^)]*)\)\s*$/.exec(title);
    criteria.push({
      id,
      title,
      heading,
      index: match.index,
      line: lineOf(source, match.index),
      body: "",
      retired: false,
      markings: markings
        ? markings[1].split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
        : [],
    });
  }
  for (const criterion of criteria) {
    criterion.retired = criterion.markings.includes(RETIRED);
  }
  // A criterion's body runs to the next heading of any level.
  for (const [position, criterion] of criteria.entries()) {
    const start = criterion.index + criterion.heading.length;
    const next = criteria[position + 1];
    const nextHeading = /^#{2,3}[ \t]/m.exec(source.slice(start));
    const end = next
      ? next.index
      : nextHeading
        ? start + nextHeading.index
        : source.length;
    criterion.body = source.slice(start, end);
    criterion.bodyStart = start;
  }
  return criteria;
}

function missingMarkings(markings) {
  const absent = [];
  if (!markings.some((marking) => CLASSES.includes(marking))) absent.push(`a verification class (${CLASSES.join(", ")})`);
  if (!markings.some((marking) => OBLIGATIONS.includes(marking))) absent.push(`an obligation (${OBLIGATIONS.join(", ")})`);
  if (!markings.some((marking) => KINDS.includes(marking))) absent.push(`a kind (${KINDS.join(", ")})`);
  if (!markings.some((marking) => TIERS.includes(marking))) absent.push(`a tier (${TIERS.join(", ")})`);
  return absent;
}

/**
 * @param {string} source full text of a document
 * @returns {Array<{rule: string, severity: "block"|"warn", line: number,
 *   span: string, message: string, criterion?: string}>}
 */
export function lintContract(source) {
  if (!isContract(source)) return [];

  const violations = [];

  const found = REQUIRED_SECTIONS.map((heading) => ({ heading, at: sectionIndex(source, heading) }));

  for (const { heading, at } of found) {
    if (at === -1) {
      violations.push({
        rule: "L-1",
        severity: "block",
        line: 1,
        span: "",
        message: `A contract must carry a "## ${heading}" section; it is absent.`,
      });
    }
  }

  const present = found.filter(({ at }) => at !== -1);
  const outOfOrder = present.find((section, position) => position > 0 && section.at < present[position - 1].at);
  if (outOfOrder !== undefined) {
    violations.push({
      rule: "L-1",
      severity: "block",
      line: lineOf(source, outOfOrder.at),
      span: `## ${outOfOrder.heading}`,
      message:
        `Sections are out of order: "${outOfOrder.heading}" appears before a ` +
        `section that must precede it. The order is ${REQUIRED_SECTIONS.join(", ")}.`,
    });
  }

  const criteria = parseCriteria(source);
  const live = criteria.filter((criterion) => !criterion.retired);

  if (criteria.length === 0) {
    violations.push({
      rule: "L-4",
      severity: "block",
      line: 1,
      span: "",
      message: 'A contract must carry at least one "### AC-nnn" criterion.',
    });
  }

  const seen = new Map();
  for (const criterion of criteria) {
    const first = seen.get(criterion.id);
    if (first === undefined) {
      seen.set(criterion.id, criterion);
      continue;
    }
    violations.push({
      rule: "L-5",
      severity: "block",
      line: criterion.line,
      span: criterion.heading,
      message:
        `${criterion.id} is already used at line ${first.line}` +
        (first.retired
          ? ". A retired identifier is never reused; choose the next unused number."
          : ". Each criterion needs its own identifier so a verdict is attributable."),
      criterion: criterion.id,
    });
  }

  for (const criterion of live) {
    const absent = missingMarkings(criterion.markings);
    if (absent.length > 0) {
      violations.push({
        rule: "L-6",
        severity: "block",
        line: criterion.line,
        span: criterion.heading,
        message: `${criterion.id} must declare ${absent.join(", ")}.`,
        criterion: criterion.id,
      });
    }
  }

  for (const criterion of live) {
    const haystack = criterion.body.toLowerCase();
    for (const predicate of BANNED_PREDICATES) {
      const at = haystack.indexOf(predicate);
      if (at === -1) continue;
      violations.push({
        rule: "L-8",
        severity: "block",
        line: lineOf(source, criterion.bodyStart + at),
        span: criterion.body.slice(at, at + predicate.length),
        message:
          `${criterion.id} uses the vague predicate "${predicate}". State the ` +
          "observable result instead, with a measurement where the claim is about " +
          "speed or scale, and the domain where it quantifies over something.",
        criterion: criterion.id,
      });
      break;
    }
  }

  for (const criterion of live) {
    // A criterion receives exactly one verdict, so it must assert exactly one
    // thing. A semicolon joining clauses, or more than one conjunction, is the
    // reliable signal that several assertions were packed into one line.
    const prose = criterion.body.trim();
    const conjunctions = (prose.match(/\band\b/g) ?? []).length;
    if (prose.includes(";") || conjunctions > 1) {
      violations.push({
        rule: "L-10",
        severity: "block",
        line: criterion.line,
        span: prose.split("\n")[0],
        message:
          `${criterion.id} asserts more than one thing. Split it so each ` +
          "criterion makes a single assertion that can receive one verdict.",
        criterion: criterion.id,
      });
    }
  }

  for (const criterion of live) {
    const prose = criterion.body.trim();

    const quantifiable = QUANTIFIABLE.exec(prose);
    if (quantifiable !== null && !/\d/.test(prose)) {
      violations.push({
        rule: "L-9",
        severity: "block",
        line: criterion.line,
        span: quantifiable[0],
        message:
          `${criterion.id} claims something about speed, scale or capacity ` +
          `("${quantifiable[0]}") without a number and unit. Say how much.`,
        criterion: criterion.id,
      });
    }

    const placeholder = PLACEHOLDERS.exec(criterion.body);
    if (placeholder !== null) {
      violations.push({
        rule: "L-11",
        severity: "block",
        line: lineOf(source, criterion.bodyStart + placeholder.index),
        span: placeholder[0],
        message: `${criterion.id} still contains placeholder text; the criterion is unfinished.`,
        criterion: criterion.id,
      });
    }
  }

  const byProse = new Map();
  for (const criterion of live) {
    const normalised = criterion.body.trim().replace(/\s+/g, " ").toLowerCase();
    if (normalised === "") continue;
    const first = byProse.get(normalised);
    if (first === undefined) {
      byProse.set(normalised, criterion);
      continue;
    }
    violations.push({
      rule: "L-14",
      severity: "block",
      line: criterion.line,
      span: criterion.heading,
      message:
        `${criterion.id} asserts the same thing as ${first.id} at line ${first.line}. ` +
        "One of them is redundant, so one verdict would be meaningless.",
      criterion: criterion.id,
    });
  }

  const negatives = sectionBody(source, "Negative Requirements").replace(/^##[^\n]*\n/, "");
  if (!NEGATIVE_REQUIREMENT.test(negatives) && !EXPLICITLY_NONE.test(negatives)) {
    violations.push({
      rule: "L-6a",
      severity: "block",
      line: lineOf(source, Math.max(sectionIndex(source, "Negative Requirements"), 0)),
      span: "",
      message:
        'The negative-requirements section must list "### NR-nnn" requirements, ' +
        'or state "None." explicitly. Silence is indistinguishable from oversight.',
    });
  }

  for (const criterion of live) {
    if (criterion.markings.includes("whitebox") && !TIER_JUSTIFICATION.test(criterion.body)) {
      violations.push({
        rule: "L-6b",
        severity: "block",
        line: criterion.line,
        span: criterion.heading,
        message:
          `${criterion.id} is whitebox, which reduces the verifier's independence. ` +
          'Add a "Tier justification:" explaining why no externally observable form exists.',
        criterion: criterion.id,
      });
    }

    const needsReviewer =
      criterion.markings.includes("human") || criterion.markings.includes("hardware");
    if (needsReviewer && !NAMED_REVIEWER.test(criterion.body)) {
      violations.push({
        rule: "L-15",
        severity: "block",
        line: criterion.line,
        span: criterion.heading,
        message:
          `${criterion.id} cannot be machine-verified, so it must name the ` +
          'reviewer role that will adjudicate it, as "Reviewer: <role>".',
        criterion: criterion.id,
      });
    }
  }

  if (live.length > 0 && !live.some((criterion) => FAILURE_PATH.test(criterion.body))) {
    violations.push({
      rule: "L-13",
      severity: "block",
      line: lineOf(source, Math.max(sectionIndex(source, "Acceptance Criteria"), 0)),
      span: "",
      message:
        "No criterion concerns a failure, boundary or refusal. A contract of only " +
        "success paths leaves the interesting behaviour unspecified.",
    });
  }

  for (const criterion of live) {
    const prose = criterion.body.trim();
    if (prose === "") continue;
    const words = prose.split(/\s+/).length;

    const quantifier = QUANTIFIERS.exec(prose);
    if (quantifier !== null) {
      violations.push({
        rule: "L-12",
        severity: "warn",
        line: criterion.line,
        span: quantifier[0],
        message:
          `${criterion.id} uses "${quantifier[0]}" — name the domain it ranges ` +
          "over, so the criterion says what was exhaustively checked.",
        criterion: criterion.id,
      });
    }

    if (words < MIN_CRITERION_WORDS || words > MAX_CRITERION_WORDS) {
      violations.push({
        rule: "L-16",
        severity: "warn",
        line: criterion.line,
        span: prose.split("\n")[0],
        message:
          `${criterion.id} is ${words} words, outside ${MIN_CRITERION_WORDS}-` +
          `${MAX_CRITERION_WORDS}. Below the floor it reads as a title; above the ` +
          "ceiling it is probably several criteria.",
        criterion: criterion.id,
      });
    }

    if (!OBSERVABLE_VERB.test(prose)) {
      violations.push({
        rule: "L-17",
        severity: "warn",
        line: criterion.line,
        span: prose.split("\n")[0],
        message:
          `${criterion.id} states no observable outcome — it reads as a noun ` +
          "phrase. Say what happens, not what the topic is.",
        criterion: criterion.id,
      });
    }

    const symbol = IMPLEMENTATION_SYMBOL.exec(prose);
    if (symbol !== null) {
      violations.push({
        rule: "L-18",
        severity: "warn",
        line: criterion.line,
        span: symbol[0],
        message:
          `${criterion.id} names an implementation detail ("${symbol[0]}"). A ` +
          "criterion describes observable behaviour, not how it is built.",
        criterion: criterion.id,
      });
    }
  }

  const authority = sectionBody(source, "Completion Authority").toLowerCase();
  if (sectionIndex(source, "Completion Authority") !== -1) {
    if (!authority.includes("independent verification") || !authority.includes("gate")) {
      violations.push({
        rule: "L-7",
        severity: "block",
        line: lineOf(source, sectionIndex(source, "Completion Authority")),
        span: "",
        message:
          "The completion authority must name independent verification and the gate " +
          "that applies, so that nobody later reads a merge as a verdict.",
      });
    }
  }

  return violations;
}
