#!/usr/bin/env node
// Org-wide mint adoption scanner. Classifies every repo:
//
//   ADOPTED      — has a .release/ intent directory (uses mint)
//   PUBLISHABLE  — package.json with a version, not private — SHOULD adopt, hasn't
//   N/A          — no versioned package / private (versioning not applicable)
//
//   node adoption.mjs            # human report
//   node adoption.mjs --json     # machine-readable to stdout
//
// Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)
import { writeFileSync } from "node:fs";

const jsonOut = process.argv.includes("--json");
const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("adoption: GITHUB_TOKEN required"); process.exit(1); }
const org = process.env.ORG ?? "bounded-systems";

async function gh(path) {
  const r = await fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json" },
  });
  if (r.status === 404) return null;
  if (!r.ok) { console.warn(`  gh ${path} → HTTP ${r.status}`); return null; }
  return r.json();
}

async function fileJson(repo, path) {
  const d = await gh(`repos/${org}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (!d?.content) return null;
  try { return JSON.parse(Buffer.from(d.content, "base64").toString("utf8")); } catch { return null; }
}

async function probe(repo) {
  const [release, pkg] = await Promise.all([
    gh(`repos/${org}/${repo}/contents/.release`), // dir listing or null
    fileJson(repo, "package.json"),
  ]);
  const adopted = Array.isArray(release) && release.some((e) => e.name.endsWith(".md"));
  const versioned = pkg != null && typeof pkg.version === "string" && pkg.private !== true;
  if (adopted) return { repo, status: "adopted", version: pkg?.version ?? null };
  if (versioned) return { repo, status: "publishable", version: pkg.version };
  return { repo, status: "na", reason: pkg == null ? "no package.json" : pkg.private ? "private" : "no version" };
}

// Paginate org repos.
const repos = [];
for (let page = 1; ; page++) {
  const batch = await gh(`orgs/${org}/repos?per_page=100&page=${page}&sort=full_name`);
  if (!batch?.length) break;
  repos.push(...batch);
  if (batch.length < 100) break;
}

// Probe in batches of 8.
const probed = [];
for (let i = 0; i < repos.length; i += 8) {
  probed.push(...await Promise.all(repos.slice(i, i + 8).map((r) => probe(r.name))));
}

const adopted = probed.filter((r) => r.status === "adopted");
const publishable = probed.filter((r) => r.status === "publishable");
const na = probed.filter((r) => r.status === "na");
const report = { org, scanned: repos.length, adopted, publishable, na };

if (jsonOut) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const denom = adopted.length + publishable.length;
  const pct = denom ? Math.round((adopted.length / denom) * 100) : 100;
  console.log(`\n  mint adoption — ${org}: ${repos.length} repos scanned\n  ${"─".repeat(48)}`);
  console.log(`  ADOPTED      ${adopted.length}`);
  for (const r of adopted) console.log(`    ✓ ${r.repo}${r.version ? ` (${r.version})` : ""}`);
  console.log(`\n  PUBLISHABLE — should adopt (${publishable.length})`);
  for (const r of publishable) console.log(`    · ${r.repo} (${r.version})`);
  console.log(`\n  N/A — not a versioned package (${na.length})`);
  console.log(`\n  coverage: ${adopted.length}/${denom} versioned packages (${pct}%)\n`);
}

writeFileSync("adoption-report.json", JSON.stringify(report, null, 2));
