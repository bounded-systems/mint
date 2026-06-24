// The deterministic core of mint.
//
// plan() is a PURE function of (currentVersion, intents, date): no filesystem,
// no Date.now(), no randomness. The same inputs always produce the same next
// version and the same changelog entry — sha in → sha out. Version arithmetic is
// delegated to `semver` (the proven core); mint owns the assembly + rendering.
import semver from "semver";
import { z } from "zod";

// Bump precedence — the strongest intent wins. Opinionated and total: every
// release resolves to exactly one bump kind, no configuration.
const BUMP_RANK = { patch: 0, minor: 1, major: 2 };
const RANK_BUMP = ["patch", "minor", "major"];

export const Bump = z.enum(["patch", "minor", "major"]);
export const Intent = z.object({
  bump: Bump,
  summary: z.string().trim().min(1, "intent summary must not be empty"),
});

const PlanInput = z.object({
  currentVersion: z.string().refine((v) => semver.valid(v) != null, "currentVersion must be valid semver"),
  intents: z.array(Intent),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD (injected, never wall-clock)"),
});

// Resolve the set of intents to a single bump kind (the max), deterministically.
export function resolveBump(intents) {
  let rank = -1;
  for (const { bump } of intents) rank = Math.max(rank, BUMP_RANK[bump]);
  return rank < 0 ? null : RANK_BUMP[rank];
}

// Render a deterministic changelog entry. Intents are grouped by kind (major →
// minor → patch) and sorted alphabetically within each group, so file read order
// never affects the output.
export function renderEntry({ nextVersion, date, intents }) {
  const SECTIONS = [
    ["major", "Major"],
    ["minor", "Minor"],
    ["patch", "Patch"],
  ];
  const lines = [`## ${nextVersion} — ${date}`, ""];
  for (const [kind, heading] of SECTIONS) {
    const summaries = intents
      .filter((i) => i.bump === kind)
      .map((i) => i.summary.trim())
      .sort();
    if (!summaries.length) continue;
    lines.push(`### ${heading}`, "");
    for (const s of summaries) lines.push(`- ${s}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// Extract the changelog section for a version: the `## <version> …` heading and
// everything up to the next `## ` heading (or EOF). Pure; returns null if absent.
// Used by `mint release` to derive the signed tag's annotation from the changelog.
export function changelogEntry(changelog, version) {
  const lines = changelog.split("\n");
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^## ${esc}(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim() + "\n";
}

// Pure plan: (currentVersion, intents, date) → release plan. Throws (via Zod) on
// malformed input; returns null bump when there are no intents (nothing to release).
export function plan(input) {
  const { currentVersion, intents, date } = PlanInput.parse(input);
  const bump = resolveBump(intents);
  if (bump == null) {
    return { currentVersion, nextVersion: currentVersion, bump: null, date, entry: null, intents: [] };
  }
  const nextVersion = semver.inc(currentVersion, bump);
  return {
    currentVersion,
    nextVersion,
    bump,
    date,
    entry: renderEntry({ nextVersion, date, intents }),
    intents,
  };
}
