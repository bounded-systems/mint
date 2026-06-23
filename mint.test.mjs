import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, resolveBump, renderEntry } from "./plan.mjs";
import { parseIntent } from "./intents.mjs";

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

test("parseIntent reads front matter + summary, validates the contract", () => {
  const i = parseIntent("---\nbump: minor\n---\nscan: promote to a verb\n");
  assert.deepEqual(i, { bump: "minor", summary: "scan: promote to a verb" });
  assert.throws(() => parseIntent("no front matter here"), /missing front-matter/);
  assert.throws(() => parseIntent("---\nbump: minor\n---\n"), /summary/); // empty body
});
