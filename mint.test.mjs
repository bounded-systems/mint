import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { plan, resolveBump, renderEntry, changelogEntry } from "./plan.mjs";
import { parseIntent } from "./intents.mjs";
import {
  releaseStatement,
  canonicalize,
  dssePAE,
  statementDigest,
  STATEMENT_TYPE,
  RELEASE_PREDICATE_TYPE,
  DSSE_PAYLOAD_TYPE,
} from "./release.mjs";

const CHANGELOG = `# Changelog

## 0.2.0 — 2026-06-24

### Minor

- mint release verb + SLSA release workflow

## 0.1.0 — 2026-06-23

### Minor

- initial
`;

const date = "2026-06-23";

test("bump precedence — the strongest intent wins", () => {
  assert.equal(resolveBump([{ bump: "patch" }, { bump: "minor" }]), "minor");
  assert.equal(resolveBump([{ bump: "minor" }, { bump: "major" }, { bump: "patch" }]), "major");
  assert.equal(resolveBump([{ bump: "patch" }]), "patch");
  assert.equal(resolveBump([]), null);
});

test("semver arithmetic is delegated correctly", () => {
  assert.equal(plan({ currentVersion: "0.6.1", intents: [{ bump: "minor", summary: "x" }], date }).nextVersion, "0.7.0");
  assert.equal(plan({ currentVersion: "0.6.1", intents: [{ bump: "patch", summary: "x" }], date }).nextVersion, "0.6.2");
  assert.equal(plan({ currentVersion: "0.6.1", intents: [{ bump: "major", summary: "x" }], date }).nextVersion, "1.0.0");
});

test("no intents → no release (version unchanged, null bump)", () => {
  const p = plan({ currentVersion: "1.2.3", intents: [], date });
  assert.equal(p.bump, null);
  assert.equal(p.nextVersion, "1.2.3");
  assert.equal(p.entry, null);
});

test("plan is deterministic — same inputs, byte-identical output regardless of intent order", () => {
  const intents = [
    { bump: "patch", summary: "fix b" },
    { bump: "minor", summary: "feat z" },
    { bump: "patch", summary: "fix a" },
    { bump: "minor", summary: "feat a" },
  ];
  const a = plan({ currentVersion: "0.6.1", intents, date });
  const b = plan({ currentVersion: "0.6.1", intents: [...intents].reverse(), date });
  assert.deepEqual(a.entry, b.entry);
  assert.equal(a.nextVersion, b.nextVersion);
  // grouped by kind (major→minor→patch), sorted within group:
  assert.match(a.entry, /### Minor\n\n- feat a\n- feat z\n\n### Patch\n\n- fix a\n- fix b/);
});

test("changelog entry header carries version + injected date", () => {
  const entry = renderEntry({ nextVersion: "0.7.0", date, intents: [{ bump: "minor", summary: "scan verb" }] });
  assert.ok(entry.startsWith("## 0.7.0 — 2026-06-23\n"));
});

test("malformed input fails closed", () => {
  assert.throws(() => plan({ currentVersion: "not-semver", intents: [], date }));
  assert.throws(() => plan({ currentVersion: "1.0.0", intents: [{ bump: "huge", summary: "x" }], date }));
  assert.throws(() => plan({ currentVersion: "1.0.0", intents: [{ bump: "minor", summary: "" }], date }));
  assert.throws(() => plan({ currentVersion: "1.0.0", intents: [], date: "June 23" }));
});

test("changelogEntry extracts one version's section, not the next", () => {
  const e = changelogEntry(CHANGELOG, "0.2.0");
  assert.ok(e.startsWith("## 0.2.0 — 2026-06-24"));
  assert.match(e, /mint release verb/);
  assert.ok(!e.includes("0.1.0"), "must stop before the next heading");
  const old = changelogEntry(CHANGELOG, "0.1.0");
  assert.ok(old.startsWith("## 0.1.0"));
  assert.match(old, /- initial/);
  assert.equal(changelogEntry(CHANGELOG, "9.9.9"), null);
});

test("parseIntent reads front matter + summary, validates the contract", () => {
  const i = parseIntent("---\nbump: minor\n---\nscan: promote to a verb\n");
  assert.deepEqual(i, { bump: "minor", summary: "scan: promote to a verb" });
  assert.throws(() => parseIntent("no front matter here"), /missing front-matter/);
  assert.throws(() => parseIntent("---\nbump: minor\n---\n"), /summary/); // empty body
});

// ── mint release — provenance core (release.mjs) ────────────────────────────

const REL = {
  version: "0.3.0",
  tag: "v0.3.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  date: "2026-06-29",
  changelog: changelogEntry(CHANGELOG, "0.2.0"),
  producer: "@bounded-systems/mint",
};

test("release statement binds tag → version plan → commit (in-toto Statement v1)", () => {
  const s = releaseStatement(REL);
  assert.equal(s._type, STATEMENT_TYPE);
  assert.equal(s._type, "https://in-toto.io/Statement/v1");
  assert.equal(s.predicateType, RELEASE_PREDICATE_TYPE);
  // subject IS the tag, anchored to the commit (in-toto gitCommit digest).
  assert.deepEqual(s.subject, [{ name: "v0.3.0", digest: { gitCommit: REL.commit } }]);
  assert.equal(s.predicate.version, "0.3.0");
  assert.equal(s.predicate.tag, "v0.3.0");
  assert.equal(s.predicate.commit, REL.commit);
  // the version plan is bound by the byte-exact changelog digest.
  assert.equal(s.predicate.plan.changelog, REL.changelog);
  assert.equal(
    s.predicate.plan.digest.sha256,
    createHash("sha256").update(REL.changelog, "utf8").digest("hex"),
  );
  // no builder ⇒ produced locally + unsigned.
  assert.equal(s.predicate.builder, null);
});

test("release statement is deterministic — same inputs, byte-identical record", () => {
  const a = releaseStatement(REL);
  const b = releaseStatement({ ...REL });
  assert.deepEqual(a, b);
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(statementDigest(a), statementDigest(b));
});

test("canonicalize is key-order independent (stable digest + DSSE payload)", () => {
  const a = canonicalize({ b: 1, a: { y: 2, x: 3 } });
  const b = canonicalize({ a: { x: 3, y: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"x":3,"y":2},"b":1}');
});

test("CI builder is carried through (keyless signing identity)", () => {
  const builder = {
    repository: "bounded-systems/mint",
    commit: REL.commit,
    ref: "refs/tags/v0.3.0",
    runId: "42",
    workflowRef: "bounded-systems/mint/.github/workflows/release.yml@refs/tags/v0.3.0",
    issuer: "https://token.actions.githubusercontent.com",
  };
  const s = releaseStatement({ ...REL, builder });
  assert.deepEqual(s.predicate.builder, builder);
  // local (null builder) and CI (builder) records differ — signing is recorded.
  assert.notEqual(statementDigest(s), statementDigest(releaseStatement(REL)));
});

test("tag format is enforced — only v<semver> is accepted", () => {
  assert.throws(() => releaseStatement({ ...REL, tag: "0.3.0" }), /tag must be v<semver>/);
  assert.throws(() => releaseStatement({ ...REL, tag: "release-0.3.0" }), /tag must be v<semver>/);
  assert.throws(() => releaseStatement({ ...REL, tag: "v0.3" }), /tag must be v<semver>/);
  // prerelease + build metadata are valid semver tags.
  assert.equal(releaseStatement({ ...REL, tag: "v0.3.0-rc.1" }).predicate.tag, "v0.3.0-rc.1");
});

test("release statement fails closed on malformed input", () => {
  assert.throws(() => releaseStatement({ ...REL, commit: "nothex!" }), /git object id/);
  assert.throws(() => releaseStatement({ ...REL, date: "June 29" }), /YYYY-MM-DD/);
  assert.throws(() => releaseStatement({ ...REL, changelog: "" }), /changelog/);
});

test("DSSE pre-authentication encoding wraps the canonical statement", () => {
  const s = releaseStatement(REL);
  const pae = dssePAE(s).toString("utf8");
  const payload = canonicalize(s);
  assert.ok(pae.startsWith(`DSSEv1 ${DSSE_PAYLOAD_TYPE.length} ${DSSE_PAYLOAD_TYPE} ${Buffer.byteLength(payload)} `));
  assert.ok(pae.endsWith(payload));
});
