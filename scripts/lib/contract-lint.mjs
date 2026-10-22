// Lints acceptance-criteria contracts. A contract opts in by declaring
// `verified_delivery: contract` in its frontmatter; every other document is
// ignored, so marking a document is the deliberate act that subjects it to
// these rules.
//
// Structural rules block: they test for presence and cannot be wrong about it.
// Lexical rules warn: their false-positive rate is unmeasured, and enforcing an
// uncalibrated judgement against the author's own prose is how a check gets
// resented and then bypassed. Promotion waits on roughly twenty real criteria
// to calibrate against. See #220 for the specification and #171 for the split.

/** Bumped when a rule is added, removed, or changes severity. */
export const RULES_VERSION = "1";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const MARKER = /^\s*verified_delivery\s*:\s*contract\s*$/m;
const CLAIMS_MARKER = /verified_delivery/;

const REQUIRED_SECTIONS = [
  "Objective",
  "Acceptance Criteria",
  "Negative Requirements",
  "Verification Requirements",
  "Completion Authority",
];

const CLASSES = ["automated", "human", "hardware"];
const OBLIGATIONS = ["required", "optional"];
const KINDS = ["verify", "assert"];
const TIERS = ["blackbox", "whitebox"];
const RETIRED = "retired";

// Any heading that reaches for a criterion identifier, well formed or not, so a
// typo is reported as a malformed identifier rather than silently ceasing to be
// a criterion at all.
const CRITERION_ATTEMPT = /^###[ \t]+((?:AC|NR)[^\s:]*)[ \t]*:[ \t]*(.*?)[ \t]*$/gm;
const WELL_FORMED_ID = /^AC-\d{3}$/;
const NEGATIVE_REQUIREMENT_ID = /^NR-\d{3}$/;
const EXPLICITLY_NONE = /^\s*none\.?\s*$/im;
const TIER_JUSTIFICATION = /tier justification\s*:/i;

export const BANNED_PREDICATES = [
  "works correctly", "correct behavior", "as expected", "where applicable",
  "handles errors", "no regressions", "user-friendly", "appropriately",
  "performant", "gracefully", "reasonable", "if needed", "intuitive",
  "scalable", "efficient", "sensible", "properly", "robust", "works",
  "clean", "fast", "slow",
].sort((a, b) => b.length - a.length);

const QUANTIFIABLE =
  /\b(responsive|responsiveness|latency|throughput|concurrent(?:ly)?|scales?|scaling|speed|per second|under load|simultaneous(?:ly)?)\b/i;
const PLACEHOLDERS = /\b(TBD|TODO|\?\?\?|etc\.|and so on)\b/i;
// Only the adverbial quantifiers. `all`, `any` and `every` almost always
// precede the domain they range over, so flagging them was pure noise.
const SCOPELESS_QUANTIFIER = /\b(never|always)\b/i;
const MIN_CRITERION_WORDS = 8;
const MAX_CRITERION_WORDS = 60;
const IMPLEMENTATION_SYMBOL =
  /(`[^`]*\.(?:ts|tsx|mjs|js|py|json|ya?ml|md)`|\b[a-z]+[A-Z][A-Za-z]*\b|\b[a-z]+_[a-z]+\b|`[^`]+\(\)`)/;
const OBSERVABLE_RESULT =
  /\b(is|are|was|were|returns?|yields?|produces?|contains?|appears?|shows?|reports?|logs?|stays?|remains?|equals?|matches?|has|have|receives?|observes?|leaves?|terminates?|continues?|accepts?|rejects?|fails?|succeeds?|assigned|created|listed|raised|surfaces?|emits?|writes?|reads?|blocks?|allows?|prevents?|denies|denied|leaks?|shares?)\b/i;
const STATED_CONDITION =
  /\b(when|while|after|before|given|once|if|during|under|upon|whenever|having)\b/i;
const FAILURE_PATH =
  /\b(error|errors|fails?|failure|rejects?|rejected|refuses?|invalid|missing|empty|cancelled|canceled|killed|denied|denies|times? out|cannot|does not|do not|never)\b/i;

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function headingIndex(source, heading) {
  const match = new RegExp(`^##\\s+${heading}\\s*$`, "m").exec(source);
  return match ? match.index : -1;
}

/** The content of a section, excluding its own heading line. */
function sectionContent(source, heading) {
  const at = headingIndex(source, heading);
  if (at === -1) return "";
  const afterHeading = source.indexOf("\n", at);
  if (afterHeading === -1) return "";
  const rest = source.slice(afterHeading + 1);
  const next = /^##[ \t]/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function readMarkings(title) {
  const declared = /\(([^)]*)\)\s*$/.exec(title);
  const parts = declared
    ? declared[1].split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
    : [];
  const pick = (permitted) => parts.find((part) => permitted.includes(part));
  return {
    declared: parts,
    class: pick(CLASSES),
    obligation: pick(OBLIGATIONS),
    kind: pick(KINDS),
    tier: pick(TIERS),
    retired: parts.includes(RETIRED),
  };
}

function parseCriteria(source) {
  const criteria = [];
  CRITERION_ATTEMPT.lastIndex = 0;
  let match;
  while ((match = CRITERION_ATTEMPT.exec(source)) !== null) {
    const [heading, id, title] = match;
    criteria.push({
      id,
      heading,
      index: match.index,
      line: lineOf(source, match.index),
      wellFormed: WELL_FORMED_ID.test(id) || NEGATIVE_REQUIREMENT_ID.test(id),
      isNegativeRequirement: NEGATIVE_REQUIREMENT_ID.test(id),
      markings: readMarkings(title),
      body: "",
      bodyStart: 0,
    });
  }
  for (const [position, criterion] of criteria.entries()) {
    const start = criterion.index + criterion.heading.length;
    const next = criteria[position + 1];
    const nextHeading = /^#{2,3}[ \t]/m.exec(source.slice(start));
    // The body stops at whichever comes first: the next criterion, or the next
    // heading of any level. Taking only the next criterion let an AC swallow the
    // "## Negative Requirements" heading when the NR entries are themselves
    // parsed as criteria.
    const bounds = [
      next ? next.index : source.length,
      nextHeading ? start + nextHeading.index : source.length,
    ];
    criterion.bodyStart = start;
    criterion.body = source.slice(start, Math.min(...bounds));
  }
  return criteria;
}

/** @returns {boolean} whether the source declares itself a contract. */
function isContract(source) {
  const frontmatter = FRONTMATTER.exec(source);
  return frontmatter !== null && MARKER.test(frontmatter[1]);
}

/**
 * @param {string} source full text of a document
 * @returns {Array<{rule: string, severity: "block"|"warn", line: number,
 *   span: string, message: string, criterion?: string, rulesVersion: string}>}
 */
export function lintContract(source) {
  const violations = [];
  const add = (severity) => (rule, line, span, message, criterion) => {
    violations.push({ rule, severity, line, span, message, criterion, rulesVersion: RULES_VERSION });
  };
  const block = add("block");
  const warn = add("warn");

  if (!isContract(source)) {
    // A document reaching for the marker but failing to parse is held, not
    // skipped: a silently ignored contract is worse than a rejected one.
    if (FRONTMATTER.exec(source) === null && CLAIMS_MARKER.test(source)) {
      block("L-1", 1, "", 'This document mentions "verified_delivery" but has no parseable frontmatter, so it cannot be read as a contract.');
      return violations;
    }
    return [];
  }

  // Required sections: present, in order, each non-empty.
  const sections = REQUIRED_SECTIONS.map((heading) => ({
    heading,
    at: headingIndex(source, heading),
    content: sectionContent(source, heading),
  }));
  for (const { heading, at, content } of sections) {
    if (at === -1) {
      block("L-1", 1, "", `A contract must carry a "## ${heading}" section; it is absent.`);
    } else if (content.trim() === "") {
      block("L-1", lineOf(source, at), `## ${heading}`, `The "${heading}" section is empty.`);
    }
  }
  const present = sections.filter(({ at }) => at !== -1);
  const outOfOrder = present.find((section, i) => i > 0 && section.at < present[i - 1].at);
  if (outOfOrder) {
    block("L-1", lineOf(source, outOfOrder.at), `## ${outOfOrder.heading}`,
      `Sections are out of order: "${outOfOrder.heading}" precedes a section that must come before it. The order is ${REQUIRED_SECTIONS.join(", ")}.`);
  }

  const parsed = parseCriteria(source);
  for (const criterion of parsed.filter((c) => !c.wellFormed)) {
    block("L-5", criterion.line, criterion.heading,
      `"${criterion.id}" is not a well-formed identifier. Criteria are AC-nnn and negative requirements are NR-nnn, three digits.`,
      criterion.id);
  }

  const criteria = parsed.filter((c) => c.wellFormed && !c.isNegativeRequirement);
  const live = criteria.filter((c) => !c.markings.retired);

  if (live.length === 0) {
    block("L-4", 1, "", 'A contract must carry at least one live "### AC-nnn" criterion; a retired criterion is history, not a requirement.');
  }

  const seen = new Map();
  for (const criterion of parsed.filter((c) => c.wellFormed)) {
    const first = seen.get(criterion.id);
    if (!first) {
      seen.set(criterion.id, criterion);
      continue;
    }
    block("L-5", criterion.line, criterion.heading,
      `${criterion.id} is already used at line ${first.line}${first.markings.retired ? ". A retired identifier is never reused; choose the next unused number." : ". Each criterion needs its own identifier so a verdict is attributable."}`,
      criterion.id);
  }

  const byProse = new Map();
  for (const criterion of live) {
    const prose = criterion.body.trim();
    const words = prose === "" ? 0 : prose.split(/\s+/).length;
    const absent = [];
    if (!criterion.markings.class) absent.push(`a verification class (${CLASSES.join(", ")})`);
    if (!criterion.markings.obligation) absent.push(`an obligation (${OBLIGATIONS.join(", ")})`);
    if (!criterion.markings.kind) absent.push(`a kind (${KINDS.join(", ")})`);
    if (!criterion.markings.tier) absent.push(`a tier (${TIERS.join(", ")})`);
    if (absent.length > 0) {
      block("L-6", criterion.line, criterion.heading, `${criterion.id} must declare ${absent.join(", ")}.`, criterion.id);
    }

    if (criterion.markings.tier === "whitebox" && !TIER_JUSTIFICATION.test(criterion.body)) {
      block("L-6b", criterion.line, criterion.heading,
        `${criterion.id} is whitebox, which reduces the verifier's independence. Add a "Tier justification:" explaining why no externally observable form exists.`,
        criterion.id);
    }

    const banned = BANNED_PREDICATES.map((p) => ({ p, at: prose.toLowerCase().indexOf(p) })).find(({ at }) => at !== -1);
    if (banned) {
      block("L-8", lineOf(source, criterion.bodyStart + banned.at), prose.slice(banned.at, banned.at + banned.p.length),
        `${criterion.id} uses the vague predicate "${banned.p}". State the observable result instead, with a measurement where the claim is about speed or scale, and the domain where it quantifies over something.`,
        criterion.id);
    }

    const quantifiable = QUANTIFIABLE.exec(prose);
    if (quantifiable && !/\d/.test(prose)) {
      block("L-9", criterion.line, quantifiable[0],
        `${criterion.id} claims something about speed, scale or capacity ("${quantifiable[0]}") without a number and unit. Say how much.`,
        criterion.id);
    }

    if (prose.includes(";") || (prose.match(/\band\b/g) ?? []).length > 1) {
      block("L-10", criterion.line, prose.split("\n")[0],
        `${criterion.id} asserts more than one thing. Split it so each criterion makes a single assertion that can receive one verdict.`,
        criterion.id);
    }

    const placeholder = PLACEHOLDERS.exec(criterion.body);
    if (placeholder) {
      block("L-11", lineOf(source, criterion.bodyStart + placeholder.index), placeholder[0],
        `${criterion.id} still contains placeholder text; the criterion is unfinished.`, criterion.id);
    }

    const normalised = prose.replace(/\s+/g, " ").toLowerCase();
    if (normalised !== "") {
      const first = byProse.get(normalised);
      if (first) {
        block("L-14", criterion.line, criterion.heading,
          `${criterion.id} asserts the same thing as ${first.id} at line ${first.line}. One of them is redundant, so one verdict would be meaningless.`,
          criterion.id);
      } else {
        byProse.set(normalised, criterion);
      }
    }

    if (prose === "") continue;

    const scopeless = SCOPELESS_QUANTIFIER.exec(prose);
    if (scopeless) {
      warn("L-12", criterion.line, scopeless[0],
        `${criterion.id} uses "${scopeless[0]}" — name the domain it ranges over, so the criterion says what was exhaustively checked.`,
        criterion.id);
    }
    if (words < MIN_CRITERION_WORDS || words > MAX_CRITERION_WORDS) {
      warn("L-16", criterion.line, prose.split("\n")[0],
        `${criterion.id} is ${words} words, outside ${MIN_CRITERION_WORDS}-${MAX_CRITERION_WORDS}. Below the floor it reads as a title; above the ceiling it is probably several criteria.`,
        criterion.id);
    }
    if (!OBSERVABLE_RESULT.test(prose) && !STATED_CONDITION.test(prose)) {
      warn("L-17", criterion.line, prose.split("\n")[0],
        `${criterion.id} states neither a condition nor an observable result — it reads as a noun phrase. Say what happens, and when.`,
        criterion.id);
    }
    const symbol = IMPLEMENTATION_SYMBOL.exec(prose);
    if (symbol) {
      warn("L-18", criterion.line, symbol[0],
        `${criterion.id} names an implementation detail ("${symbol[0]}"). A criterion describes observable behaviour, not how it is built.`,
        criterion.id);
    }
  }

  if (live.length > 0 && !live.some((c) => FAILURE_PATH.test(c.body))) {
    block("L-13", lineOf(source, Math.max(headingIndex(source, "Acceptance Criteria"), 0)), "",
      "No criterion concerns a failure, boundary or refusal. A contract of only success paths leaves the interesting behaviour unspecified.");
  }

  const negatives = sectionContent(source, "Negative Requirements");
  if (!parsed.some((c) => c.isNegativeRequirement) && !EXPLICITLY_NONE.test(negatives)) {
    block("L-6a", lineOf(source, Math.max(headingIndex(source, "Negative Requirements"), 0)), "",
      'The negative-requirements section must list "### NR-nnn" requirements, or state "None." explicitly. Silence is indistinguishable from oversight.');
  }

  const authority = sectionContent(source, "Completion Authority").toLowerCase();
  if (headingIndex(source, "Completion Authority") !== -1 &&
      (!authority.includes("independent verification") || !authority.includes("gate"))) {
    block("L-7", lineOf(source, headingIndex(source, "Completion Authority")), "",
      "The completion authority must name independent verification and the gate that applies, so that nobody later reads a merge as a verdict.");
  }

  return violations;
}
