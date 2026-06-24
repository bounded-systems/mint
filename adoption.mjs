#!/usr/bin/env node
// Org-wide mint adoption scanner. Classifies every repo:
//
//   ADOPTED      — has a .release/ intent directory (uses mint)
//   PUBLISHABLE  — package.json with a version, not private — SHOULD adopt, hasn't
//   N/A          — no versioned package / private (versioning not applicable)
//
//   node adoption.mjs            # human report
//   node adoption.mjs --json     # machine-readable to stdout
//   node adoption.mjs --write    # open a caller PR for each publishable-not-adopted repo
//
// Env: GITHUB_TOKEN (required), ORG (default: bounded-systems), MINT_REF (pin)
import { writeFileSync } from "node:fs";

const jsonOut = process.argv.includes("--json");
const write = process.argv.includes("--write");
const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("adoption: GITHUB_TOKEN required"); process.exit(1); }
const org = process.env.ORG ?? "bounded-systems";
const MINT_REF = process.env.MINT_REF ?? "7bc5c9c0826aa7bcb1fc78c8286ab6cc6311630a";

async function ghReq(path, { method = "GET", body } = {}) {
  const r = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
      "User-Agent": "bounded-systems-mint", // GitHub rejects UA-less requests as abuse
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 404) return null;
  if (!r.ok) { console.warn(`  gh ${method} ${path} → HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`); return null; }
  return r.json();
}
const gh = (path) => ghReq(path);

// Caller files dropped into each adopting repo.
const b64 = (s) => Buffer.from(s).toString("base64");
const VERSION_YML = `name: version

# Versioning via the bounded-systems mint capability. Validates .release/ intents
# (fails closed on a malformed one) and previews the next version on every PR.
# Pinned to an immutable mint commit SHA; bump when mint tags.
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  version:
    uses: bounded-systems/mint/.github/workflows/version.yml@${MINT_REF} # mint
    with:
      ref: ${MINT_REF}
`;
const RELEASE_README = `# Release intents

This repo uses [@bounded-systems/mint](https://github.com/bounded-systems/mint) for
versioning. Each PR with a user-facing change drops an intent file here; mint
resolves the strongest bump and cuts the release deterministically.

Format — \`.release/<slug>.md\`:

    ---
    bump: minor   # patch | minor | major
    ---
    short summary of the change (becomes the changelog line)

The \`version\` CI job runs \`mint plan\`, which validates every intent and previews
the next version.
`;

async function putFile(repo, path, content, branch, message) {
  return ghReq(`repos/${org}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    body: { message, content: b64(content), branch },
  });
}

// Open a caller PR adopting mint in one repo. Idempotent-ish: skips if the branch
// already exists. Returns { repo, pr, url } or null.
async function openAdoptionPR(repo) {
  const meta = await gh(`repos/${org}/${repo}`);
  const base = meta?.default_branch ?? "main";
  const ref = await gh(`repos/${org}/${repo}/git/ref/heads/${base}`);
  if (!ref?.object?.sha) { console.warn(`  ${repo}: no ${base} ref`); return null; }
  const branch = "adopt-mint";
  const made = await ghReq(`repos/${org}/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: ref.object.sha } });
  if (!made) { console.warn(`  ${repo}: branch exists or create failed — skipping`); return null; }
  await putFile(repo, ".github/workflows/version.yml", VERSION_YML, branch, "chore: adopt @bounded-systems/mint for versioning");
  await putFile(repo, ".release/README.md", RELEASE_README, branch, "chore: add .release intent directory");
  const pr = await ghReq(`repos/${org}/${repo}/pulls`, {
    method: "POST",
    body: { title: "chore: adopt @bounded-systems/mint for versioning", head: branch, base, body: "Adopt the [mint](https://github.com/bounded-systems/mint) reusable version-check (validates `.release/` intents + previews the next bump on every PR). Org-wide versioning rollout — see bounded-systems/string-audit#43." },
  });
  if (!pr?.number) return null;
  console.log(`  ✓ ${repo.padEnd(24)} PR #${pr.number}`);
  return { repo, pr: pr.number, url: pr.html_url, branch };
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

// --write: open a caller PR for every publishable-not-adopted repo.
if (write) {
  console.log(`\n  opening caller PRs for ${publishable.length} publishable repo(s) (mint @ ${MINT_REF.slice(0, 8)})\n`);
  const opened = [];
  for (const r of publishable) {
    const pr = await openAdoptionPR(r.repo);
    if (pr) opened.push(pr);
  }
  report.opened = opened;
  console.log(`\n  opened ${opened.length}/${publishable.length} PR(s)`);
}

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
