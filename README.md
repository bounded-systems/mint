# @bounded-systems/mint

Deterministic versioning — **intent files in, signed release out**. A *seam over
[`semver`](https://github.com/npm/node-semver)*: mint owns the flow (intent
assembly, changelog, tagging, provenance) and delegates only the version
arithmetic to the proven core.

Built because tagging-by-hand drifts: a manifest left behind its release tags is
a recurring bug ([string-audit#42](https://github.com/bounded-systems/string-audit/issues/42)).
mint makes the version a per-PR declaration and the release a single atomic step.

## Principles

- **Opinionated** — one canonical release flow, no configurable branching.
- **Strongly deterministic** — `plan()` is a *pure function* of `(currentVersion, intents, date)`. No commit-history ordering, no `Date.now()`, no randomness. Same intents in → same version + changelog out (sha in → sha out).
- **Typed end-to-end** — intents and plan validated with Zod; a verbspec CLI/MCP surface mirrors the rest of the stack.
- **Owned** — delegate only `semver` arithmetic; own assembly, rendering, tagging, and provenance.

## Use

Each PR drops an intent in `.release/` (see [`.release/README.md`](.release/README.md)):

```markdown
---
bump: minor
---
scan: promote to a verb (CLI + MCP) + shared Zod type contracts
```

Then:

```sh
mint plan      # preview: 0.6.1 → 0.7.0 (minor) + the changelog entry
mint version   # apply: bump package.json + lockfile, prepend CHANGELOG.md, consume intents
mint release   # cut + sign the tag  (coming soon)
```

`mint plan --json` emits the machine-readable plan. `--date YYYY-MM-DD` pins the
changelog date (the pure core never reads the clock; the CLI injects it).

## Library

```js
import { plan } from "@bounded-systems/mint";

plan({
  currentVersion: "0.6.1",
  intents: [{ bump: "minor", summary: "scan: promote to a verb" }],
  date: "2026-06-23",
}).nextVersion; // "0.7.0"
```

## Roadmap

- [x] Deterministic `plan` core + Zod intent contract
- [x] `mint plan` / `mint version`
- [ ] `mint release` — signed tag + SLSA attestation via [`anchored-chain`](https://github.com/bounded-systems/anchored-chain)
- [ ] verbspec-typed CLI + MCP surface
- [ ] Reusable `workflow_call` Action (mirroring string-audit's `audit.yml`)
- [ ] Publish to npm + JSR

Tracking: [bounded-systems/string-audit#43](https://github.com/bounded-systems/string-audit/issues/43).

## License

PolyForm-Noncommercial-1.0.0
