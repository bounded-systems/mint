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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

// --- the release lane: one entry point, chained, and pinned to the tag -------
//
// Helpers shared by the workflow tests below. Two lessons are baked in, both
// learned by writing a check that passed against the defect it was meant to
// catch:
//
//   - `code()` strips comment lines. These workflows are heavily commented, and
//     a comment naming the thing being asserted satisfies a naive `includes()`
//     — the check then reads green against a file that never got the fix.
//   - `job()` slices ONE job, not "from this job to end of file". An assertion
//     scoped to the whole file is satisfied by a neighbouring job that happens
//     to carry the line, which is how a `tag:` pin was "verified" on a job that
//     did not have one.
const wf = (name) => readFileSync(new URL(`./.github/workflows/${name}`, import.meta.url), "utf8");
const code = (src) => src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
function job(src, id) {
  const lines = code(src).split("\n");
  const at = lines.findIndex((l) => l === `  ${id}:`);
  assert.notEqual(at, -1, `job '${id}' not found`);
  const out = [lines[at]];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^(\S|  \S)/.test(lines[i])) break; // next job, or a top-level key, begins
    out.push(lines[i]);
  }
  return out.join("\n");
}
const workflowNames = () =>
  readdirSync(new URL("./.github/workflows/", import.meta.url)).filter((f) => f.endsWith(".yml"));

// THE PRESCRIBED CALLER FILENAME (#48).
//
// npm's trusted publishing validates the ENTRY workflow's filename, not the file
// containing `npm publish`, and a package may have exactly ONE trusted publisher
// configured. So a repo may have exactly one entry workflow that reaches npm,
// and mint prescribes its name org-wide: `release.yml`.
//
// mint had two — `cut.yml` (dispatch) and `release.yml` (tag push) — which is
// unregisterable: npm validates a different name depending on how the release
// started, and only one of the two can be configured. That is the defect this
// asserts stays fixed, and it is not a property any single file can state about
// itself: it is a property of the DIRECTORY, so the whole directory is the
// fixture.
const NPM_ENTRY = "release.yml";
const PUBLISH_LANE = "npm-publish.yml";

test("exactly one workflow is an npm entry point, and it is the prescribed name", () => {
  const reaches = workflowNames().filter((f) => {
    const src = code(wf(f));
    return /\bnpm publish\b/.test(src) || new RegExp(`uses:.*${PUBLISH_LANE.replace(".", "\\.")}`).test(src);
  });

  // npm-publish.yml contains the publish but is NOT an entry point: it has only
  // a workflow_call trigger, so no event can start a run at it and npm never
  // validates its name. Anything else in this list is a second registerable
  // entry — the exact shape that cannot be configured.
  const laneSrc = code(wf(PUBLISH_LANE));
  assert.match(laneSrc, /^on:\n\s+workflow_call:$/m, `${PUBLISH_LANE} must be reusable-only — a second trigger makes it an entry point`);

  assert.deepEqual(
    reaches.sort(),
    [NPM_ENTRY, PUBLISH_LANE].sort(),
    `npm validates the entry workflow's filename and a package gets ONE trusted publisher, ` +
      `so exactly one file may reach npm: ${NPM_ENTRY}. Found: ${reaches.join(", ")}`,
  );

  assert.match(
    readFileSync(new URL("./docs/npm-trusted-publishing.md", import.meta.url), "utf8"),
    new RegExp(`\\.github/workflows/${NPM_ENTRY.replace(".", "\\.")}`),
    "the convention doc does not name the entry workflow it prescribes",
  );
});

// #39/#48: the release stopped needing someone's laptop (#22) when the tag cut
// moved into CI, and it stops needing two workflow files here.
//
// Three properties, and each is the kind a later edit undoes by accident:
//
//   1. The downstream work must be CHAINED, not triggered. GitHub creates no
//      runs from GITHUB_TOKEN events, so `push: tags` will not fire for a tag
//      release-cut pushed. A `cut` job with nothing depending on it produces a
//      tag and no release — green, and empty.
//   2. Everything must be pinned to the resolved tag. Chained, the run's event
//      is workflow_dispatch on a BRANCH, so an unpinned checkout tests, packs,
//      attests and publishes MAIN under a version tag's name.
//   3. A dry run must publish nothing.
test("release.yml: both triggers, chained cut, one resolved tag", () => {
  const src = wf(NPM_ENTRY);
  const body = code(src);

  assert.match(body, /^\s{2}push:\n\s{4}tags: \["v\*"\]$/m, "the tag-push path is gone — a laptop cut would do nothing");
  assert.match(body, /^\s{2}workflow_dispatch:$/m, "the dispatch path is gone — the release needs a laptop again");

  assert.match(job(src, "cut"), /uses:\s*\.\/\.github\/workflows\/release-cut\.yml/, "the cut job does not call release-cut");
  assert.match(
    job(src, "cut"),
    /if:\s*github\.event_name == 'workflow_dispatch'/,
    "the cut must be dispatch-only — on a tag push the tag already exists",
  );

  // The dry-run gate. `cut` reports cut: 'false' for a dry run, so gating the
  // whole chain on that one output is what makes dry-run mean "publish nothing".
  assert.match(
    job(src, "resolve"),
    /needs\.cut\.outputs\.cut\s*==\s*'true'/,
    "nothing gates the chain on an actual cut — a dry run would publish",
  );
  assert.match(
    job(src, "resolve"),
    /!cancelled\(\)/,
    "resolve must run when `cut` is SKIPPED (the tag-push path); a plain needs: would skip it too",
  );

  // Every checkout of mint's own repo must name the resolved tag. One unpinned
  // checkout is enough to release the dispatch branch.
  const checkouts = body.split("\n").filter((l) => l.includes("actions/checkout@")).length;
  const pinned = (body.match(/ref:\s*\$\{\{\s*needs\.resolve\.outputs\.tag\s*\}\}/g) || []).length;
  assert.equal(
    pinned,
    checkouts,
    `${checkouts} checkout(s) but ${pinned} pinned to the resolved tag — an unpinned one releases the dispatch branch`,
  );

  const shellRefs = body.split("\n").filter((l) => l.includes("$GITHUB_REF_NAME"));
  assert.deepEqual(shellRefs, [], "a $GITHUB_REF_NAME expansion survives — on a chained run that is the branch");
});

// The recovery door. A publish can fail on its own — mint's own npm sat three
// tags behind because v0.7.0/0.7.1/0.7.2's registry publishes never ran — and
// re-cutting is not the recovery: release-cut refuses an existing tag, by design.
// So `recover-tag` republishes an existing tag, and must skip the two things that
// already landed: the cut, and the GitHub release (published releases are
// IMMUTABLE, so re-uploading 422s for work that succeeded).
//
// The subtle half is the registries. They `needs: [release, resolve]`, and a
// SKIPPED dependency skips its dependents by default — so without an explicit
// status condition the recovery door would run the resolve and then publish
// nothing at all, greenly. That is the failure shape this whole file exists to
// catch, so it is asserted rather than trusted.
test("release.yml: the recovery door republishes without re-cutting or re-releasing", () => {
  const src = wf(NPM_ENTRY);
  const body = code(src);

  assert.match(body, /^\s{6}recover-tag:$/m, "the recover-tag input is missing");
  assert.match(
    job(src, "cut"),
    /inputs\.recover-tag == ''/,
    "the cut must be skipped on the recovery door — release-cut refuses an existing tag",
  );
  assert.match(job(src, "resolve"), /RECOVER: \$\{\{ inputs\.recover-tag \}\}/, "resolve must read the recovery tag");
  assert.match(
    job(src, "resolve"),
    /inputs\.recover-tag != ''/,
    "the recovery door is not an accepted entry — resolve would skip and publish nothing",
  );
  // The condition, not its exact spelling: the `if:` also has to carry a status
  // function (see the skip-taint test below), so pinning the whole expression
  // makes this fixture fight that one.
  assert.match(
    job(src, "release"),
    /if:.*inputs\.recover-tag == ''/,
    "the GitHub release must be skipped on recovery — a published release is immutable",
  );

  for (const registry of ["npm", "jsr"]) {
    assert.match(
      job(src, registry),
      /needs\.release\.result == 'skipped'/,
      `${registry} must still run when \`release\` is SKIPPED, or the recovery door publishes nothing`,
    );
  }
});

// The environment claim is the half of the npm pin that only exists if the
// PUBLISHING job carries `environment:` itself. mint used a no-op `approve` job
// for the gate, which blocks the publish but puts no `environment` claim in the
// publishing job's OIDC token — so npm's Environment field could not be set,
// and the gate was job ordering rather than something a registry can verify.
test("release.yml: both registry publishes are environment-gated", () => {
  const src = wf(NPM_ENTRY);
  assert.match(job(src, "npm"), /environment:\s*npm-publish/, "the npm lane is not passed the environment");
  assert.match(job(src, "jsr"), /environment:\s*npm-publish/, "the jsr publish is not environment-gated");
});

// --- npm-publish.yml: the lane every consumer was rebuilding by hand ---------
//
// #48. Each assertion below is a defect that reached a real release, so each one
// is a regression test rather than a style rule.
test("npm-publish.yml: asserts the version floors and never mutates npm", () => {
  const body = code(wf(PUBLISH_LANE));

  // 11.5.1, not 11.5.0 — all three hand-rolled publishers asserted the wrong floor.
  assert.match(body, /NPM_FLOOR:\s*11\.5\.1\b/, "the npm floor is not 11.5.1");
  assert.match(body, /NODE_FLOOR:\s*22\.14\.0\b/, "the node floor is not 22.14.0");
  assert.match(body, /exit 1/, "the floor check does not fail the job");

  // `npm install -g npm@latest` in a release path is how npm v12 arrived
  // unannounced and killed a publish (site-mcp#38). Assert it is gone from EVERY
  // workflow, not just this one — the next copy of it would land elsewhere.
  for (const f of workflowNames()) {
    assert.doesNotMatch(
      code(wf(f)),
      /npm\s+install\s+-g\s+npm/,
      `${f} mutates npm in CI — assert the floor instead; an unpinned upgrade is site-mcp#38`,
    );
  }
});

test("npm-publish.yml: cache off, tag-pinned, idempotent, provenance", () => {
  const src = wf(PUBLISH_LANE);
  const body = job(src, "publish");

  assert.match(body, /package-manager-cache:\s*false/, "setup-node still caches — npm advises against it for release builds");

  const checkouts = body.split("\n").filter((l) => l.includes("actions/checkout@")).length;
  const pinned = (body.match(/ref:\s*\$\{\{\s*inputs\.tag\s*\|\|\s*github\.ref_name\s*\}\}/g) || []).length;
  assert.equal(checkouts, 1, "expected exactly one checkout in the publish job");
  assert.equal(pinned, checkouts, "the checkout is not pinned to the tag — a chained run would publish main");

  // Idempotence: the publish step must be GATED on the registry probe, not merely
  // preceded by it. A probe whose output nothing reads is a green check that
  // gates nothing.
  assert.match(body, /id:\s*on-npm/, "the already-published probe is missing");
  assert.match(
    body,
    /if:\s*steps\.on-npm\.outputs\.skip\s*!=\s*'true'\n[^\n]*\n?[\s\S]{0,400}?npm publish/,
    "the publish is not gated on the probe — a recovery re-dispatch would go red on a version that already landed",
  );
  assert.match(body, /npm publish --access "\$ACCESS" --provenance/, "provenance is not attached");

  // The environment claim can only come from the publishing job itself: a job
  // with `uses:` may not carry `environment:`, so a caller cannot add it.
  assert.match(body, /environment:\s*\$\{\{\s*inputs\.environment\s*\}\}/, "the publish job is not environment-gated");
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
    // Flag-order tolerant: #45 inserted --cleanup=verbatim between the tag and
    // -F, and this assertion is about annotating FROM A FILE, not about argv
    // order.
    /git tag -a "\$TAG"[^\n]* -F /,
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

// --- the tag annotation must keep the changelog's markdown headings ---------
//
// #45, and a correction to #43. git tag defaults to --cleanup=strip, which
// deletes every line starting with `#` — and a mint entry opens with
// `## <version>` and `### <bump>`. So the annotation was a strict SUBSET of the
// changelog entry, not the byte-identical copy #43 claimed: every tag mint has
// ever cut lost its headings, laptop cuts included (v0.5.0's annotation is
// bullets-only).
//
// Cosmetic for a single-section entry. Destructive for a multi-section one: the
// `### Minor` / `### Patch` split disappears and the bullets merge into one
// undifferentiated list. It also breaks the property #43 was reaching for — the
// Statement digests predicate.plan.changelog, so a subset means the notes and
// the signed record are not the same bytes.
test("mint release: the tag annotation keeps the changelog headings (#45)", () => {
  const d = mkdtempSync(join(tmpdir(), "mint-tag-"));
  // ISOLATE THE MACHINE'S GIT CONFIG. Without this the test reads whatever the
  // developer happens to have set, and the first draft passed here while failing
  // in CI for a reason that had nothing to do with what it was testing: this
  // machine sets commit.gpgsign, a bare runner does not, and `git config --get`
  // EXITS 1 on an unset key — so `mint release` died with
  // `Command failed: git config --get commit.gpgsign`.
  //
  // That was a real bug in the laptop path, not a test artifact, and it was
  // invisible precisely because the verdict depended on ambient state. Pinning
  // both config files to /dev/null makes this test say the same thing
  // everywhere, and covers the unsigned path deterministically.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  try {
    const git = (...args) => execFileSync("git", args, { cwd: d, stdio: "pipe", env }).toString();
    git("init", "-q", ".");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@x/y", version: "0.2.0" }, null, 2) + "\n");
    // Two sections on purpose: this is the case where stripping the headings
    // loses information rather than merely looking untidy.
    writeFileSync(
      join(d, "CHANGELOG.md"),
      "# Changelog\n\n## 0.2.0 — 2026-01-01\n\n### Minor\n\n- a minor thing\n\n### Patch\n\n- a patch thing\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    execFileSync("node", [MINT, "release", "--no-push", "--no-attest"], { cwd: d, stdio: "pipe", env });

    const annotation = git("tag", "-l", "--format=%(contents)", "v0.2.0");
    assert.match(annotation, /^## 0\.2\.0 — 2026-01-01$/m, "the version heading must survive");
    assert.match(annotation, /^### Minor$/m, "the Minor heading must survive");
    assert.match(annotation, /^### Patch$/m, "the Patch heading must survive");
    assert.match(annotation, /- a minor thing/);
    assert.match(annotation, /- a patch thing/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// The CI path cuts its own tag, so it needs the same flag — and there is no
// cheap end-to-end for it here, since the step runs on a runner.
test("release-cut.yml: the tag is annotated with --cleanup=verbatim (#45)", () => {
  const src = readFileSync(new URL("./.github/workflows/release-cut.yml", import.meta.url), "utf8");
  assert.match(
    src,
    /git tag -a "\$TAG" --cleanup=verbatim -F /,
    "without --cleanup=verbatim git strips the entry's `##` and `###` heading lines",
  );
});

// --- every job downstream of a skippable job needs a STATUS FUNCTION ---------
//
// GitHub propagates a skip through the entire `needs` CLOSURE, not one hop.
// `cut` is SKIPPED on two of the three doors (tag push, and recovery), so every
// job transitively needing it is skipped too — unless that job ITSELF calls a
// status function (`always()`, `cancelled()`, `success()`, `failure()`). A plain
// condition does NOT clear the taint, and neither does an upstream job having
// cleared it: `resolve`'s `!cancelled()` covers `resolve` alone.
//
// This shipped broken. site-mcp's v0.3.0 recovery dispatch resolved the tag,
// skipped every job beneath it, and reported SUCCESS having published nothing —
// the exact "green control that gates nothing" these fixtures exist to prevent.
// It survived because a DRY RUN skips those same jobs on purpose, so a green dry
// run carries no information about this defect at all.
//
// The rule is structural, so the assertion is too: the closure is derived from
// the file rather than from a list of job names a later edit would leave stale.
test("every job downstream of `cut` calls a status function", () => {
  const src = code(wf(NPM_ENTRY));
  const section = src.slice(src.indexOf("\njobs:") + 1);

  const jobs = {};
  let cur = null;
  for (const line of section.split("\n").slice(1)) {
    const m = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (m) { cur = m[1]; jobs[cur] = ""; continue; }
    if (cur) jobs[cur] += line + "\n";
  }

  const needsOf = (block) => {
    const m = /^\s*needs:\s*(.+)$/m.exec(block);
    if (!m) return [];
    const raw = m[1].trim();
    return raw.startsWith("[")
      ? raw.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
      : [raw];
  };

  const downstream = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [job, block] of Object.entries(jobs)) {
      if (downstream.has(job)) continue;
      if (needsOf(block).some((n) => n === "cut" || downstream.has(n))) {
        downstream.add(job);
        grew = true;
      }
    }
  }
  assert.ok(downstream.size >= 3, `expected cut to have downstream jobs, found ${downstream.size}`);

  const STATUS_FN = /\b(always|cancelled|success|failure)\s*\(\s*\)/;
  for (const job of downstream) {
    const cond = /^\s*if:\s*(.+)$/m.exec(jobs[job])?.[1] ?? "";
    assert.match(
      cond,
      STATUS_FN,
      `job \`${job}\` is downstream of the skippable \`cut\` but its \`if:\` calls no status ` +
        `function — GitHub skips it on the tag-push and recovery doors, and the run reports ` +
        `success having done nothing. Found if: ${cond || "(none)"}`,
    );
  }
});

// --- a caller must grant everything the lane declares, or nothing runs --------
//
// GitHub validates a called workflow's `permissions:` as the UNION with the
// caller's, at LOAD time — before any `if:`, and regardless of which steps would
// execute. Withholding one produces `startup_failure`: no job starts, so there
// is no job log to read and no failing step to point at (site-mcp#36 lost a
// dispatch to exactly this, over `actions: read` on release-provenance).
//
// So when the lane gains a permission, mint's own caller has to gain it in the
// same commit. Deriving both sides from the files makes that automatic rather
// than remembered.
test("release.yml's npm caller grants everything npm-publish.yml declares", () => {
  const perms = (src) => {
    const m = /^permissions:\n((?:  \w[\w-]*:[^\n]*\n)+)/m.exec(code(src));
    assert.ok(m, "no top-level permissions block");
    return new Set(
      m[1].split("\n").filter(Boolean).map((l) => l.trim().replace(/\s*#.*$/, "")),
    );
  };
  const declared = perms(wf(PUBLISH_LANE));

  const callerBlock = job(wf(NPM_ENTRY), "npm");
  const granted = new Set(
    [...callerBlock.matchAll(/^\s{6}([\w-]+:\s*\w+)/gm)].map((m) => m[1].replace(/\s+/g, " ")),
  );

  for (const p of declared) {
    assert.ok(
      granted.has(p),
      `npm-publish.yml declares \`${p}\` but release.yml's npm job does not grant it. ` +
        `GitHub unions these at LOAD time, so the whole run fails with startup_failure — ` +
        `no job, no log. Granted: ${[...granted].join(", ") || "(none)"}`,
    );
  }
});
