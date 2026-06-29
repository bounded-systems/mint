#!/usr/bin/env node
// mint — deterministic versioning CLI. Impurity (clock, filesystem, git) lives
// here at the edge; plan.mjs stays a pure function.
//
//   mint plan    [--dir .release] [--date YYYY-MM-DD] [--json]   preview the next release
//   mint version [--dir .release] [--date YYYY-MM-DD]            apply: bump manifest + CHANGELOG, consume intents
//   mint release [--dry-run] [--no-push] [--no-attest]           cut the v<version> tag + emit release provenance
//   mint attest  [--out <path>]                                  (re)emit the in-toto release Statement (CI signs it)
//
// A verbspec-typed CLI/MCP surface (mirroring string-audit's audit.mjs/mcp.mjs)
// is a follow-up; this skeleton wires the verbs directly against the Zod core.
import { readFile, writeFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { plan, changelogEntry } from "./plan.mjs";
import { loadIntents } from "./intents.mjs";
import { releaseStatement, statementDigest } from "./release.mjs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const gitOk = (...a) => { try { execFileSync("git", a, { stdio: "ignore" }); return true; } catch { return false; } };

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name) => args.includes(name);

const today = () => new Date().toISOString().slice(0, 10); // wall-clock confined to the CLI edge
const dir = flag("--dir") ?? ".release";
const date = flag("--date") ?? today();

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function currentVersion() {
  const pkg = await readJson("package.json");
  if (!pkg.version) throw new Error("package.json has no version field");
  return pkg.version;
}

async function cmdPlan() {
  const intents = await loadIntents(dir);
  const p = plan({ currentVersion: await currentVersion(), intents, date });
  if (has("--json")) {
    process.stdout.write(JSON.stringify(p, null, 2) + "\n");
    return;
  }
  if (p.bump == null) {
    console.log(`mint: no intents in ${dir}/ — nothing to release (stays ${p.currentVersion})`);
    return;
  }
  console.log(`mint plan — ${p.currentVersion} → ${p.nextVersion}  (${p.bump}, ${intents.length} intent${intents.length !== 1 ? "s" : ""})\n`);
  console.log(p.entry);
}

async function cmdVersion() {
  const intents = await loadIntents(dir);
  const p = plan({ currentVersion: await currentVersion(), intents, date });
  if (p.bump == null) {
    console.log(`mint: no intents in ${dir}/ — nothing to release`);
    return;
  }

  // Bump the manifest (+ lockfile if present), preserving 2-space JSON.
  const pkg = await readJson("package.json");
  pkg.version = p.nextVersion;
  await writeFile("package.json", JSON.stringify(pkg, null, 2) + "\n");
  try {
    const lock = await readJson("package-lock.json");
    lock.version = p.nextVersion;
    if (lock.packages?.[""]) lock.packages[""].version = p.nextVersion;
    await writeFile("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // Keep jsr.json in lockstep (JSR has its own manifest version).
  try {
    const jsr = await readJson("jsr.json");
    jsr.version = p.nextVersion;
    await writeFile("jsr.json", JSON.stringify(jsr, null, 2) + "\n");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  // Prepend the entry to CHANGELOG.md (create with a header if absent).
  let changelog = "";
  try { changelog = await readFile("CHANGELOG.md", "utf8"); }
  catch (e) { if (e.code !== "ENOENT") throw e; changelog = "# Changelog\n"; }
  const head = changelog.startsWith("# ") ? changelog.slice(0, changelog.indexOf("\n") + 1) : "# Changelog\n";
  const rest = changelog.slice(head.length).replace(/^\n+/, "");
  await writeFile("CHANGELOG.md", `${head}\n${p.entry}\n${rest}`.replace(/\n{3,}/g, "\n\n"));

  // Consume the intents.
  for (const i of intents) if (i.file) await unlink(i.file);

  console.log(`mint: ${p.currentVersion} → ${p.nextVersion} (${p.bump}). Updated package.json + CHANGELOG.md, consumed ${intents.length} intent(s).`);
  console.log(`Next: commit, then \`mint release\` to cut the tag + emit release provenance.`);
}

// The GitHub Actions OIDC issuer enforced by the bounded-systems keyless flow.
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";

// The CI signing identity, derived from the GitHub Actions environment. Returns
// null outside CI (no GITHUB_REPOSITORY) — the statement is then UNSIGNED and the
// release record carries `builder: null`. Mirrors the sites' provenance builder.
function ciBuilder() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) return null;
  return {
    repository,
    commit: process.env.GITHUB_SHA ?? "",
    ref: process.env.GITHUB_REF ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "",
    issuer: OIDC_ISSUER,
  };
}

// Assemble the in-toto release Statement from repo state. Impure at the edge
// (reads package.json + CHANGELOG + git HEAD + CI env); delegates the pure shape
// to release.mjs. Throws with a CLI-friendly message on a missing changelog entry.
async function gatherStatement() {
  const pkg = await readJson("package.json");
  const version = pkg.version;
  if (!version) throw new Error("package.json has no version");
  const tag = `v${version}`;

  let changelog = "";
  try { changelog = await readFile("CHANGELOG.md", "utf8"); } catch { /* none */ }
  const entry = changelogEntry(changelog, version);
  if (!entry) throw new Error(`no CHANGELOG.md entry for ${version} — run \`mint version\` first.`);

  const commit = git("rev-parse", "HEAD");
  // Producer is mint itself, not the consumer package; pin a ref when CI sets one.
  const producer = `@bounded-systems/mint${process.env.MINT_REF ? `@${process.env.MINT_REF}` : ""}`;
  const stmt = releaseStatement({ version, tag, commit, date, changelog: entry, producer, builder: ciBuilder() });
  return { stmt, tag, entry, version };
}

// (Re)emit the in-toto release Statement to stdout (or --out <path>). Pure +
// deterministic for a given repo state; CI keyless-signs the emitted file with
// cosign. Same record `mint release` writes — exposed on its own so release.yml
// can regenerate it after the tag push and sign it.
async function cmdAttest() {
  const { stmt, tag } = await gatherStatement();
  const text = JSON.stringify(stmt, null, 2) + "\n";
  const out = flag("--out");
  if (out) {
    await writeFile(out, text);
    console.error(`mint: wrote release statement for ${tag} → ${out} (${statementDigest(stmt).slice(0, 12)})`);
  } else {
    process.stdout.write(text);
  }
}

// Cut the release tag AND emit its provenance. Signs the tag when git signing is
// configured (else an annotated tag with a warning); the annotation is the
// changelog entry. Alongside the tag it writes the in-toto release Statement
// (tag → version plan → commit) to `<tag>.intoto.json` — UNSIGNED locally;
// keyless-signed by release.yml in CI (cosign, OIDC). --dry-run previews without
// touching git; --remote sets the push target (default origin); --no-push skips
// pushing; --no-attest skips the provenance file; --attest <path> overrides it.
async function cmdRelease() {
  const dryRun = has("--dry-run");
  const noPush = has("--no-push");
  const noAttest = has("--no-attest");
  const remote = flag("--remote") ?? "origin";

  let gathered;
  try { gathered = await gatherStatement(); }
  catch (e) { console.error(`mint release: ${e.message}`); process.exit(1); }
  const { stmt, tag, entry } = gathered;
  const attestPath = flag("--attest") ?? `${tag}.intoto.json`;
  const stmtText = JSON.stringify(stmt, null, 2) + "\n";
  const signedStatement = stmt.predicate.builder != null; // CI ⇒ keyless-signed downstream
  const signedTag = git("config", "--get", "commit.gpgsign") === "true" || gitOk("config", "--get", "user.signingkey");
  const tagExists = gitOk("rev-parse", tag);
  const dirty = git("status", "--porcelain");

  // --dry-run is a pure preview: it never touches git, so the mutation guards
  // (clean tree, tag absent) are surfaced as warnings instead of hard failures.
  if (dryRun) {
    console.log(`mint release (dry run): would create ${signedTag ? "signed" : "annotated"} tag ${tag} and ${noPush ? "skip push" : `push to ${remote}`}.`);
    if (!noAttest) console.log(`mint release (dry run): would write release provenance → ${attestPath} (${statementDigest(stmt).slice(0, 12)}, ${signedStatement ? "CI keyless-signs it" : "unsigned — signing is CI-only"}).`);
    if (tagExists) console.log(`mint release (dry run): note — tag ${tag} already exists; a real release would refuse.`);
    if (dirty) console.log("mint release (dry run): note — working tree not clean; a real release would refuse.");
    console.log("");
    console.log(entry.trimEnd());
    if (!noAttest) { console.log("\n--- in-toto release Statement (preview) ---"); process.stdout.write(stmtText); }
    return;
  }

  // Guards for the real path: tag not already present, clean git tree.
  if (tagExists) { console.error(`mint release: tag ${tag} already exists.`); process.exit(1); }
  if (dirty) { console.error("mint release: working tree not clean — commit the release first."); process.exit(1); }

  git("tag", signedTag ? "-s" : "-a", tag, "-m", entry);
  console.log(`mint: created ${signedTag ? "signed" : "annotated (unsigned — no git signing key configured)"} tag ${tag}`);
  if (!noAttest) {
    await writeFile(attestPath, stmtText);
    console.log(`mint: wrote release provenance → ${attestPath}${signedStatement ? "" : " (unsigned — keyless signing runs in CI)"}`);
  }
  if (!noPush) { git("push", remote, tag); console.log(`mint: pushed ${tag} to ${remote}`); }
  console.log(`Next: release.yml keyless-signs the statement (cosign, OIDC) + attaches it to the GitHub release. Verify with \`cosign verify-blob\` / \`gh attestation verify\`.`);
}

const COMMANDS = { plan: cmdPlan, version: cmdVersion, release: cmdRelease, attest: cmdAttest };

if (!cmd || cmd === "--help" || cmd === "-h" || !COMMANDS[cmd]) {
  const known = Object.keys(COMMANDS).join(" | ");
  console.log(`mint — deterministic versioning\n\n  mint <${known}> [--dir .release] [--date YYYY-MM-DD] [--json]\n`);
  process.exit(cmd && !COMMANDS[cmd] ? 1 : 0);
}

await COMMANDS[cmd]();
