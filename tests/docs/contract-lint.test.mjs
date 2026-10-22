import assert from "node:assert/strict";
import test from "node:test";

import { lintContract } from "../../scripts/lib/contract-lint.mjs";

test("a document without the contract marker is not a contract and yields no violations", () => {
  const source = [
    "---",
    "title: Documentation suite specification",
    "---",
    "",
    "# Documentation suite specification",
    "",
    "Prose with no acceptance criteria, no sections, and the word 'robust' in it.",
  ].join("\n");

  assert.deepEqual(lintContract(source), []);
});

const MARKED = ["---", "verified_delivery: contract", "---", ""].join("\n");

test("a contract missing a required section is blocked, naming the section", () => {
  const source = [
    MARKED,
    "# Pass 1: agent session isolation",
    "",
    "## Objective",
    "",
    "Concurrent agents operate independently.",
    "",
    "## Negative Requirements",
    "",
    "None.",
    "",
    "## Verification Requirements",
    "",
    "- Independent verification for every required criterion",
    "",
    "## Completion Authority",
    "",
    "Independent verification, post-merge gate.",
  ].join("\n");

  const violations = lintContract(source);
  const missing = violations.filter((violation) => violation.rule === "L-1");

  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, "block");
  assert.match(missing[0].message, /Acceptance Criteria/);
});

const WELL_FORMED_CRITERION = [
  "### AC-001: Session identity (automated, required, verify, blackbox)",
  "",
  "Two sessions created at the same moment are assigned different identifiers.",
].join("\n");

const WELL_FORMED_NEGATIVE_CRITERION = [
  "### AC-002: Missing context errors (automated, required, verify, blackbox)",
  "",
  "A read of a context that does not exist returns an error rather than another",
  "session's context.",
].join("\n");

/** Builds a contract that is well formed unless a block is overridden. */
function buildContract({ criteria, negatives } = {}) {
  return [
    MARKED,
    "# Pass 1: agent session isolation",
    "",
    "## Objective",
    "",
    "Concurrent agents operate independently.",
    "",
    "## Acceptance Criteria",
    "",
    criteria ?? [WELL_FORMED_CRITERION, WELL_FORMED_NEGATIVE_CRITERION].join("\n\n"),
    "",
    "## Negative Requirements",
    "",
    negatives ?? "### NR-001: No shared buffer (required)\n\nNo transcript buffer is shared across sessions.",
    "",
    "## Verification Requirements",
    "",
    "- Independent verification for every required criterion",
    "",
    "## Completion Authority",
    "",
    "Independent verification, post-merge gate.",
  ].join("\n");
}

test("a well-formed contract yields no violations", () => {
  assert.deepEqual(lintContract(buildContract()), []);
});

test("a criterion without its four markings is blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Session identity",
        "",
        "Two sessions created at the same moment are assigned different identifiers.",
      ].join("\n"),
    }),
  );
  const markings = violations.filter((violation) => violation.rule === "L-6");

  assert.equal(markings.length, 1);
  assert.equal(markings[0].severity, "block");
  assert.equal(markings[0].criterion, "AC-001");
});

test("a banned vague predicate is blocked with a message naming what is missing", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Error handling (automated, required, verify, blackbox)",
        "",
        "Error handling works correctly when a session is cancelled.",
      ].join("\n"),
    }),
  );
  const banned = violations.filter((violation) => violation.rule === "L-8");

  assert.equal(banned.length, 1);
  assert.equal(banned[0].severity, "block");
  assert.equal(banned[0].criterion, "AC-001");
  assert.equal(banned[0].span, "works correctly");
  assert.match(banned[0].message, /observable result|measurement|domain/);
});

test("prose outside the criteria is not subject to the lexical rules", () => {
  const violations = lintContract(
    buildContract({
      negatives: "### NR-001: No silent fallback (required)\n\nNo code path works around a missing context.",
    }),
  );

  assert.deepEqual(violations.filter((violation) => violation.rule === "L-8"), []);
});

// Regression anchor: the one true positive measured against real repository
// prose, from DOCUMENTATION_SUITE_SPEC.md's migration plan. Five assertions on
// one line, so it can never receive a single verdict.
test("the compound assertion measured in the existing spec is blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Site toolchain (automated, required, verify, blackbox)",
        "",
        "Select VitePress 1.6.4; verify project base-path build support, built-in",
        "local search, source includes, static output, and Actions artifact",
        "deployment workflow.",
      ].join("\n"),
    }),
  );
  const compound = violations.filter((violation) => violation.rule === "L-10");

  assert.equal(compound.length, 1);
  assert.equal(compound[0].severity, "block");
  assert.equal(compound[0].criterion, "AC-001");
});

test("a single assertion containing one conjunction is not compound", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Cancellation (automated, required, verify, blackbox)",
        "",
        "Cancelling one session leaves the other three running to completion.",
      ].join("\n"),
    }),
  );

  assert.deepEqual(violations.filter((violation) => violation.rule === "L-10"), []);
});

test("two criteria sharing an identifier are blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        WELL_FORMED_CRITERION,
        "",
        "### AC-001: Context containment (automated, required, verify, blackbox)",
        "",
        "A cross-session read returns a permission error.",
      ].join("\n"),
    }),
  );
  const duplicates = violations.filter((violation) => violation.rule === "L-5");

  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "block");
  assert.equal(duplicates[0].criterion, "AC-001");
});

test("a retired criterion holds its identifier without needing the other markings", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Session identity (retired)",
        "",
        "Superseded by AC-003; kept so the identifier is never reused.",
        "",
        WELL_FORMED_CRITERION.replace("AC-001", "AC-003"),
        "",
        WELL_FORMED_NEGATIVE_CRITERION,
      ].join("\n"),
    }),
  );

  assert.deepEqual(violations, []);
});

test("reusing a retired identifier is blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Session identity (retired)",
        "",
        "Superseded.",
        "",
        WELL_FORMED_CRITERION,
        "",
        WELL_FORMED_NEGATIVE_CRITERION,
      ].join("\n"),
    }),
  );

  assert.equal(violations.filter((violation) => violation.rule === "L-5").length, 1);
});

test("a contract with no criteria at all is blocked", () => {
  const violations = lintContract(buildContract({ criteria: "None yet." }));
  const empty = violations.filter((violation) => violation.rule === "L-4");

  assert.equal(empty.length, 1);
  assert.equal(empty[0].severity, "block");
});

test("a performance claim without a number and unit is blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Editor responsiveness (automated, required, verify, blackbox)",
        "",
        "The editor stays responsive under load.",
      ].join("\n"),
    }),
  );
  const unquantified = violations.filter((violation) => violation.rule === "L-9");

  assert.equal(unquantified.length, 1);
  assert.equal(unquantified[0].severity, "block");
  assert.equal(unquantified[0].criterion, "AC-001");
});

test("a quantified performance claim passes", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Concurrent throughput (automated, required, verify, blackbox)",
        "",
        "Four sessions running concurrently for 60 seconds produce no cross-session",
        "transcript entry.",
      ].join("\n"),
    }),
  );

  assert.deepEqual(violations.filter((violation) => violation.rule === "L-9"), []);
});

test("placeholder text is blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Crash recovery (automated, required, verify, blackbox)",
        "",
        "A killed session is recoverable. TODO: decide what recoverable means.",
      ].join("\n"),
    }),
  );
  const placeholders = violations.filter((violation) => violation.rule === "L-11");

  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].severity, "block");
  assert.equal(placeholders[0].span, "TODO");
});

test("two criteria with identical wording are blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        WELL_FORMED_CRITERION,
        "",
        WELL_FORMED_CRITERION.replace("AC-001", "AC-002").replace("Session identity", "Identifier distinctness"),
      ].join("\n"),
    }),
  );
  const duplicates = violations.filter((violation) => violation.rule === "L-14");

  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "block");
  assert.equal(duplicates[0].criterion, "AC-002");
});

test("an empty negative-requirements section is blocked, since silence is not consideration", () => {
  const violations = lintContract(buildContract({ negatives: "" }));
  const negatives = violations.filter((violation) => violation.rule === "L-6a");

  assert.equal(negatives.length, 1);
  assert.equal(negatives[0].severity, "block");
});

test("an explicit statement of no negative requirements satisfies the rule", () => {
  const violations = lintContract(buildContract({ negatives: "None." }));

  assert.deepEqual(violations.filter((violation) => violation.rule === "L-6a"), []);
});

test("a whitebox criterion without a tier justification is blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Transcript isolation at rest (automated, required, assert, whitebox)",
        "",
        "No stored transcript contains an entry belonging to another session.",
        "",
        WELL_FORMED_NEGATIVE_CRITERION,
      ].join("\n"),
    }),
  );
  const unjustified = violations.filter((violation) => violation.rule === "L-6b");

  assert.equal(unjustified.length, 1);
  assert.equal(unjustified[0].severity, "block");
  assert.equal(unjustified[0].criterion, "AC-001");
});

test("a contract of only happy paths is blocked for having no failure-path criterion", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        WELL_FORMED_CRITERION,
        "",
        "### AC-002: Session count (automated, required, verify, blackbox)",
        "",
        "Four sessions are listed once four have been created.",
      ].join("\n"),
    }),
  );
  const happy = violations.filter((violation) => violation.rule === "L-13");

  assert.equal(happy.length, 1);
  assert.equal(happy[0].severity, "block");
});

test("a human-class criterion without a named reviewer is blocked", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Editor feel (human, required, verify, blackbox)",
        "",
        "A first-time user reaches a saved model without asking for help.",
        "",
        WELL_FORMED_NEGATIVE_CRITERION,
      ].join("\n"),
    }),
  );
  const unassigned = violations.filter((violation) => violation.rule === "L-15");

  assert.equal(unassigned.length, 1);
  assert.equal(unassigned[0].criterion, "AC-001");
});

test("a completion authority that does not name independent verification is blocked", () => {
  const source = buildContract().replace(
    "Independent verification, post-merge gate.",
    "The maintainer decides when it is done.",
  );
  const violations = lintContract(source);
  const authority = violations.filter((violation) => violation.rule === "L-7");

  assert.equal(authority.length, 1);
  assert.equal(authority[0].severity, "block");
});

test("an absolute quantifier without a stated domain warns rather than blocks", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Isolation (automated, required, verify, blackbox)",
        "",
        "A session never leaks.",
        "",
        WELL_FORMED_NEGATIVE_CRITERION,
      ].join("\n"),
    }),
  );
  const quantifiers = violations.filter((violation) => violation.rule === "L-12");

  assert.equal(quantifiers.length, 1);
  assert.equal(quantifiers[0].severity, "warn");
});

test("a criterion short enough to be a title warns", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Isolation (automated, required, verify, blackbox)",
        "",
        "Sessions are isolated.",
        "",
        WELL_FORMED_NEGATIVE_CRITERION,
      ].join("\n"),
    }),
  );
  const lengths = violations.filter((violation) => violation.rule === "L-16");

  assert.equal(lengths.length, 1);
  assert.equal(lengths[0].severity, "warn");
});

test("a criterion naming an implementation symbol warns", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Buffer allocation (automated, required, verify, blackbox)",
        "",
        "The transcript buffer in `packages/orchestrator/src/session.ts` is allocated",
        "once for each distinct session identity rather than once for the module.",
        "",
        WELL_FORMED_NEGATIVE_CRITERION,
      ].join("\n"),
    }),
  );
  const coupled = violations.filter((violation) => violation.rule === "L-18");

  assert.equal(coupled.length, 1);
  assert.equal(coupled[0].severity, "warn");
});

test("a criterion with no verb reads as a noun phrase and warns", () => {
  const violations = lintContract(
    buildContract({
      criteria: [
        "### AC-001: Session identity (automated, required, verify, blackbox)",
        "",
        "Distinct per-session identifiers across concurrent agent sessions, 4 of them.",
        "",
        WELL_FORMED_NEGATIVE_CRITERION,
      ].join("\n"),
    }),
  );
  const fragments = violations.filter((violation) => violation.rule === "L-17");

  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].severity, "warn");
});

test("a document claiming to be a contract but carrying no structure fails loudly", () => {
  const violations = lintContract([MARKED, "Some notes I have not finished."].join("\n"));

  assert.ok(violations.length >= 5, "every missing section should be reported");
  assert.ok(violations.every((violation) => violation.severity === "block"));
});

test("linting is deterministic", () => {
  const source = buildContract({
    criteria: [
      "### AC-001: Error handling (automated, required, verify, blackbox)",
      "",
      "Error handling works correctly; it never fails.",
    ].join("\n"),
  });

  assert.deepEqual(lintContract(source), lintContract(source));
});

test("required sections present but out of order are blocked", () => {
  const source = [
    MARKED,
    "# Pass 1",
    "",
    "## Acceptance Criteria",
    "",
    WELL_FORMED_CRITERION,
    "",
    WELL_FORMED_NEGATIVE_CRITERION,
    "",
    "## Objective",
    "",
    "Concurrent agents operate independently.",
    "",
    "## Negative Requirements",
    "",
    "None.",
    "",
    "## Verification Requirements",
    "",
    "- Independent verification for every required criterion",
    "",
    "## Completion Authority",
    "",
    "Independent verification, post-merge gate.",
  ].join("\n");

  const ordering = lintContract(source).filter((violation) => violation.rule === "L-1");

  assert.equal(ordering.length, 1);
  assert.equal(ordering[0].severity, "block");
  assert.match(ordering[0].message, /order/i);
});
