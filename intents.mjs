// Intent files: `.release/*.md` — one per change, authored in the PR that makes
// the change. Format is front-matter + summary body:
//
//   ---
//   bump: minor
//   ---
//   scan: promote to a verb (CLI + MCP) + shared Zod type contracts
//
// Parsed and validated against the Zod `Intent` contract in plan.mjs. No YAML
// dependency — the front matter is a minimal `key: value` block.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Intent } from "./plan.mjs";

const FRONT_MATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

// Parse one intent file's text → validated { bump, summary }. Throws on a missing
// front-matter block, unknown bump, or empty summary (fail closed — a malformed
// intent must never silently drop from a release).
export function parseIntent(text, label = "intent") {
  const m = text.match(FRONT_MATTER);
  if (!m) throw new Error(`${label}: missing front-matter block (--- bump: <kind> ---)`);
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  const summary = m[2].trim();
  return Intent.parse({ bump: fields.bump, summary });
}

// Load every intent in a directory (default `.release/`), skipping README.md and
// dot/underscore-prefixed templates. Returns [] when the directory is absent.
export async function loadIntents(dir = ".release") {
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const files = names
    .filter((n) => n.endsWith(".md"))
    .filter((n) => n !== "README.md" && !n.startsWith("_") && !n.startsWith("."))
    .sort();
  const intents = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), "utf8");
    intents.push({ file: join(dir, f), ...parseIntent(text, f) });
  }
  return intents;
}
