#!/usr/bin/env node
// mint — deterministic versioning CLI. Impurity (clock, filesystem, git) lives
// here at the edge; plan.mjs stays a pure function.
//
//   mint plan    [--dir .release] [--date YYYY-MM-DD] [--json]   preview the next release
//   mint version [--dir .release] [--date YYYY-MM-DD]            apply: bump manifest + CHANGELOG, consume intents
//   mint release                                                 cut + sign the tag (not yet implemented)
//
// A verbspec-typed CLI/MCP surface (mirroring string-audit's audit.mjs/mcp.mjs)
// is a follow-up; this skeleton wires the verbs directly against the Zod core.
import { readFile, writeFile, unlink } from "node:fs/promises";
import { plan } from "./plan.mjs";
import { loadIntents } from "./intents.mjs";

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
  console.log(`Next: commit, then \`mint release\` to cut the signed tag.`);
}

function cmdRelease() {
  console.error("mint release: not yet implemented — signed tag + SLSA attestation via anchored-chain is a follow-up (see bounded-systems/string-audit#43).");
  process.exit(1);
}

const COMMANDS = { plan: cmdPlan, version: cmdVersion, release: cmdRelease };

if (!cmd || cmd === "--help" || cmd === "-h" || !COMMANDS[cmd]) {
  const known = Object.keys(COMMANDS).join(" | ");
  console.log(`mint — deterministic versioning\n\n  mint <${known}> [--dir .release] [--date YYYY-MM-DD] [--json]\n`);
  process.exit(cmd && !COMMANDS[cmd] ? 1 : 0);
}

await COMMANDS[cmd]();
