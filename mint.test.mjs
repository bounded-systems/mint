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

// ── CLI manifest handling: mint reads/bumps deno.json, not just package.json (#13)
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MINT = fileURLToPath(new URL("./mint.mjs", import.meta.url));

function bumpIn(manifestName) {
  const d = mkdtempSync(join(tmpdir(), "mint-cli-"));
  try {
    writeFileSync(
      join(d, manifestName),
      JSON.stringify({ name: "@x/y", version: "0.1.0", exports: "./m.ts" }, null, 2) + "\n",
    );
    mkdirSync(join(d, ".release"));
    writeFileSync(join(d, ".release", "i.md"), "---\nbump: minor\n---\nx\n");
    execFileSync("node", [MINT, "version"], { cwd: d, stdio: "pipe" });
    return JSON.parse(readFileSync(join(d, manifestName), "utf8")).version;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("mint version bumps a deno.json-only repo (#13)", () => {
  assert.equal(bumpIn("deno.json"), "0.2.0");
});

test("mint version still bumps a jsr.json / package.json repo", () => {
  assert.equal(bumpIn("jsr.json"), "0.2.0");
  assert.equal(bumpIn("package.json"), "0.2.0");
});

// --- release-cut.yml: the two halves of one allow-list must agree -----------
//
// release-cut.yml states its trusted-trigger allow-list TWICE: once as the
// `guard` job's runtime `case`, once as the static `if:` on `cut`. Both are
// needed — the `if:` is what CodeQL can see, the `case` is what fails LOUDLY
// instead of skipping silently — but two copies of one rule drift, and drift
// here means one of them silently permits an event the other refuses.
//
// So the file is the fixture: parse both lists out of it and require they
// match. Widening one without the other fails the suite.
test("release-cut.yml: guard case and cut if: allow the same events", () => {
  const src = readFileSync(new URL("./.github/workflows/release-cut.yml", import.meta.url), "utf8");

  const caseArm = src.match(/^\s*(workflow_dispatch[^)]*)\)\s*echo\s+"trigger/m);
  assert.ok(caseArm, "could not find the guard job's case arm — did the guard get renamed or removed?");
  const fromCase = new Set(caseArm[1].split("|").map((s) => s.trim()).filter(Boolean));

  const ifLine = src.match(/^\s*if:\s*(github\.event_name\s*==.*)$/m);
  assert.ok(ifLine, "could not find the static if: on the cut job — CodeQL's half of the guard is missing");
  const fromIf = new Set([...ifLine[1].matchAll(/github\.event_name\s*==\s*'([^']+)'/g)].map((m) => m[1]));

  assert.deepEqual(
    [...fromCase].sort(),
    [...fromIf].sort(),
    "release-cut.yml's runtime allow-list and its static if: disagree — one would permit an event the other refuses",
  );
  assert.ok(fromCase.size > 0, "allow-list is empty, which would refuse every trigger");
  for (const denied of ["pull_request", "pull_request_target"]) {
    assert.ok(!fromCase.has(denied), `${denied} must never be trusted: a fork PR would control the version being tagged`);
  }
});

// --- release-provenance.yml: never publish a release before it is complete ---
//
// #19: a published GitHub release is immutable, so whoever publishes first locks
// everyone else out — drift-gate v0.2.0 shipped with NO binaries because this
// workflow published the release before the repo's binaries job could attach
// them (`HTTP 422: Cannot upload assets to an immutable release`).
//
// The fix is an ordering, and an ordering is exactly what a later edit can undo
// without noticing. So the file is the fixture: creation must be a draft, and
// publishing must come after the attach.
test("release-provenance.yml: creates a draft and publishes only after attaching", () => {
  const src = readFileSync(new URL("./.github/workflows/release-provenance.yml", import.meta.url), "utf8");

  const create = src.match(/^\s*gh release create .*$/m);
  assert.ok(create, "no `gh release create` — did the attach step get renamed or removed?");
  assert.match(
    create[0],
    /--draft\b/,
    "`gh release create` must pass --draft: a published release is immutable, so creating it published " +
      "is what makes every later asset upload fail with 422 (#19)",
  );

  const attachAt = src.indexOf("gh release create");
  const publishAt = src.indexOf("--draft=false");
  assert.ok(publishAt !== -1, "nothing ever publishes the draft — the release would stay invisible");
  assert.ok(
    publishAt > attachAt,
    "the release is published before its assets are attached — that is the #19 ordering bug, reintroduced",
  );
});

// --- the CI-cut path: chained, and pinned to the tag it cut ------------------
//
// #39: release-cut.yml was built so a release stops needing someone's laptop
// (#22), and mint had not adopted it — the tool could not ship without the
// manual step it exists to remove. cut.yml adopts it here.
//
// Two properties, and both are the kind a later edit undoes by accident:
//
//   1. The downstream work must be CHAINED, not triggered. GitHub creates no
//      runs from GITHUB_TOKEN events, so release.yml's `push: tags` will not
//      fire for a tag release-cut pushed. A `cut` job with nothing depending on
//      it produces a tag and no release — green, and empty.
//   2. release.yml must be pinned to the cut tag. Chained, the run's event is
//      workflow_dispatch on a branch, so an unpinned checkout tests, packs,
//      attests and publishes MAIN under a version tag's name.
test("cut.yml: chains the release and passes the cut tag", () => {
  const src = readFileSync(new URL("./.github/workflows/cut.yml", import.meta.url), "utf8");

  assert.match(src, /uses:\s*\.\/\.github\/workflows\/release-cut\.yml/, "cut.yml does not call release-cut");
  assert.match(
    src,
    /uses:\s*\.\/\.github\/workflows\/release\.yml/,
    "nothing chains release.yml — a tag pushed by GITHUB_TOKEN triggers no workflow, so the release would never happen",
  );
  assert.match(src, /needs:\s*cut/, "the release job must depend on the cut");
  assert.match(
    src,
    /tag:\s*\$\{\{\s*needs\.cut\.outputs\.tag\s*\}\}/,
    "the cut tag is not passed to release.yml — chained, it would release the branch this was dispatched from",
  );
  assert.match(
    src,
    /if:\s*needs\.cut\.outputs\.cut\s*==\s*'true'/,
    "the release must be gated on an actual cut, or a dry run would publish",
  );
});

test("release.yml: callable, and every checkout is pinned to the tag", () => {
  const src = readFileSync(new URL("./.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(src, /^\s{2}workflow_call:$/m, "release.yml is not callable — cut.yml cannot chain it");
  assert.match(src, /^\s{6}tag:$/m, "the `tag` input is missing");

  // Every checkout of the caller's own repo must name the tag. One unpinned
  // checkout is enough to publish the branch.
  const checkouts = src.split("\n").filter((l) => l.includes("actions/checkout@")).length;
  const pinned = (src.match(/ref:\s*\$\{\{\s*inputs\.tag\s*\|\|\s*github\.ref_name\s*\}\}/g) || []).length;
  assert.equal(
    pinned,
    checkouts,
    `${checkouts} checkout(s) but ${pinned} pinned to the tag — an unpinned one releases the dispatch branch`,
  );

  const shellRefs = src.split("\n").filter((l) => !l.trim().startsWith("#") && l.includes("$GITHUB_REF_NAME"));
  assert.deepEqual(shellRefs, [], "a $GITHUB_REF_NAME expansion survives — on a chained run that is the branch");
});

// --- release-provenance.yml: the tag comes from the input, not the event ------
//
// #37: release-cut.yml's header prescribes chaining this workflow as a dependent
// job, because a tag GITHUB_TOKEN pushes triggers nothing. But that run's event
// is workflow_dispatch on a BRANCH, so `github.ref_name` is the branch. With the
// tag read from the event, the chained job checked out main, attested main's
// HEAD, and created a draft release literally named `main` — while the real
// v<version> tag got no release and no provenance.
//
// Two properties, and the second is the one a later edit would quietly undo:
// the checkout must be pinned to the resolved tag, and nothing may read
// $GITHUB_REF_NAME afterwards — one leftover reference is enough to send a
// chained release back to the branch.
test("release-provenance.yml: resolves the tag from the input, never from the event", () => {
  const src = readFileSync(new URL("./.github/workflows/release-provenance.yml", import.meta.url), "utf8");

  assert.match(src, /^\s{6}tag:$/m, "the `tag` input is missing — chained callers cannot name the tag");
  assert.match(
    src,
    /TAG:\s*\$\{\{\s*inputs\.tag\s*\|\|\s*github\.ref_name\s*\}\}/,
    "TAG must fall back to github.ref_name, so the tag-push path stays byte-identical",
  );
  assert.match(
    src,
    /ref:\s*\$\{\{\s*inputs\.tag\s*\|\|\s*github\.ref_name\s*\}\}/,
    "the caller checkout must be pinned to the resolved tag — otherwise a chained run attests the branch",
  );

  // Comments may still name it; a shell expansion may not.
  const shellRefs = src.split("\n").filter((l) => !l.trim().startsWith("#") && l.includes("$GITHUB_REF_NAME"));
  assert.deepEqual(
    shellRefs,
    [],
    "a $GITHUB_REF_NAME expansion survives — on a chained run that is the branch, which is exactly #37",
  );
});

// The artifact hand-off is the one-writer path out of #19: assets are attached by
// this job rather than by a second workflow racing it for the same release. It
// needs `actions: read` to see the run, and a called workflow only ever gets the
// intersection with its caller — so the permission has to be declared here too.
test("release-provenance.yml: assets-artifact input is wired and permitted", () => {
  const src = readFileSync(new URL("./.github/workflows/release-provenance.yml", import.meta.url), "utf8");

  assert.match(src, /^\s{6}assets-artifact:$/m, "assets-artifact input is missing");
  assert.match(src, /^\s{6}finalize:$/m, "finalize input is missing");
  assert.match(
    src,
    /^\s*actions:\s*read\b/m,
    "`actions: read` is missing — `gh run download` cannot fetch the caller's artifact without it",
  );
  assert.match(
    src,
    /gh run download "\$GITHUB_RUN_ID"/,
    "the artifact must come from the CALLER's run — a reusable workflow shares its run id",
  );
});

// --- release-cut.yml: the tag annotation IS the release notes ---------------
//
// #42. Both release workflows publish with `--notes-from-tag`, so whatever this
// step writes as the annotation becomes the GitHub release body. It wrote the
// tag name, which shipped v0.7.0 with a one-line body where `mint release` from
// a checkout writes the whole changelog entry (cmdRelease: `git tag -a $tag -m
// entry`). The dispatched path and the laptop path are supposed to reach the
// same end state; that one is the difference between a release record and a
// string.
//
// A dry run cannot catch this: the annotation is written only in the step gated
// on `!inputs.dry-run`, so every guard passes while the one wrong line never
// runs. Hence a fixture.
test("release-cut.yml: the tag annotation is the changelog, not the tag name", () => {
  const src = readFileSync(new URL("./.github/workflows/release-cut.yml", import.meta.url), "utf8");
  const step = src.slice(src.indexOf("- name: Cut and push the tag"));
  const body = step.slice(0, step.indexOf("- name: Dry-run summary"));

  assert.doesNotMatch(
    body,
    /git tag -a "\$TAG" -m "\$TAG"/,
    'the annotation must not be the tag name — that is the #42 defect verbatim',
  );
  assert.match(
    body,
    /git tag -a "\$TAG" -F /,
    "annotate from a file: the changelog entry is multi-line and full of backticks",
  );
  // The notes must come from the Statement the guard step already derived, so
  // the annotation is byte-identical to the entry that Statement attests rather
  // than a second rendering free to drift from it.
  assert.match(
    body,
    /predicate\.plan\.changelog/,
    "the notes must be read out of the release Statement's attested changelog entry",
  );
});
