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
mint release   # cut the v<version> tag + emit release provenance (CI keyless-signs it)
```

`mint plan --json` emits the machine-readable plan. `--date YYYY-MM-DD` pins the
changelog date (the pure core never reads the clock; the CLI injects it).

## Release provenance

`mint release` cuts the annotated tag `v<version>` (signed when a git signing key
is configured) **and** emits a release **provenance record** — an
[in-toto Statement v1](https://in-toto.io/Statement/v1) binding the three things a
release is:

```
tag  →  version plan  →  commit
```

The subject is the tag, anchored to its commit (in-toto `gitCommit` digest); the
predicate carries the byte-exact changelog entry (the deterministic `plan()`
output) and its `sha256`. Re-deriving the plan over the same intents reproduces
that digest — the tag-to-plan link is machine-checkable, offline.

The Statement is **deterministic** (`releaseStatement()` is pure, like `plan()`)
and **keyless-signed in CI**: `release.yml` runs `mint attest`, then
`cosign sign-blob` binds the signature to the workflow's OIDC identity (Fulcio +
Rekor — no key material). Locally the Statement is emitted **unsigned**
(`builder: null`) so the flow degrades gracefully off-CI. This is the same
Statement / DSSE / keyless-Sigstore shape the bounded-systems sites and
[`@bounded-systems/verify`](https://github.com/bounded-systems/verify) already
produce and verify, so a mint release record verifies with the same tooling:

```sh
cosign verify-blob \
  --bundle mint-release.intoto.sigstore.json \
  --certificate-identity-regexp '^https://github.com/<org>/<repo>/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  mint-release.intoto.json
```

> **anchored-chain:** mint deliberately mirrors
> [`anchored-chain`](https://github.com/bounded-systems/anchored-chain)'s in-toto
> constants + Statement/DSSE shape rather than depending on it: anchored-chain's
> in-toto module is Phase-0 and not yet re-exported from its public surface, is
> bun/TypeScript with a build step, and its predicate models a *derivation
> chain*, not a release. mint stays a zero-build node ESM package and can adopt
> anchored-chain's `Signer`/`Verifier` once that surface lands — the bytes
> already match.

### Adopt mint's release in CI

A consumer repo calls the reusable
[`release-provenance.yml`](.github/workflows/release-provenance.yml) on its tag
push (a ~10-line caller — see the header of that workflow):

```yaml
# .github/workflows/release.yml
name: release
on: { push: { tags: ["v*"] } }
permissions: { contents: write, id-token: write }
jobs:
  release:
    uses: bounded-systems/mint/.github/workflows/release-provenance.yml@<sha>
    with: { ref: <sha> }
```

`adoption.mjs --write` drops both this caller and the `version.yml` caller into
every publishable repo — the path off hand-tagging.

## Publish (npm + JSR)

mint ships from `release.yml` on each `v*` tag via **OIDC trusted publishing** —
no `NPM_TOKEN`, no JSR token, ever. The package manifests are kept in lockstep by
`mint version` (it bumps `package.json`, `package-lock.json`, **and** `jsr.json`).

JSR-readiness is verified the same way CI publishes:

```sh
npx jsr publish --dry-run --allow-slow-types   # the path release.yml runs
deno publish    --dry-run --allow-slow-types   # equivalent, Deno-native
```

`jsr.json` carries the SPDX `license` and a `publish.include` allowlist, so the
published tarball is just the three exports + `mint.mjs`, `README`, `CHANGELOG`
(no tests, lockfiles, or workflows). `@types/node` is a dev dependency so the
JSR type-checker resolves mint's `node:` imports.

> **One-time JSR link (manual, once):** before the first JSR publish, link the
> package on [jsr.io](https://jsr.io) — create `@bounded-systems/mint` under the
> `@bounded-systems` scope and connect it to the `bounded-systems/mint` GitHub
> repo (Settings → "Link to a GitHub repository"). That GitHub link is what
> authorizes the keyless OIDC publish; after it, every tagged release publishes
> with no token.

## Library

```js
import { plan } from "@bounded-systems/mint";
import { releaseStatement } from "@bounded-systems/mint/release";

plan({
  currentVersion: "0.6.1",
  intents: [{ bump: "minor", summary: "scan: promote to a verb" }],
  date: "2026-06-23",
}).nextVersion; // "0.7.0"

releaseStatement({
  version: "0.7.0",
  tag: "v0.7.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  date: "2026-06-23",
  changelog: "## 0.7.0 — 2026-06-23\n\n### Minor\n\n- scan: promote to a verb\n",
  producer: "@bounded-systems/mint",
})._type; // "https://in-toto.io/Statement/v1"
```

## Roadmap

- [x] Deterministic `plan` core + Zod intent contract
- [x] `mint plan` / `mint version`
- [x] `mint release` — signed tag + in-toto release provenance, keyless-signed in CI (cosign/Sigstore; anchored-chain-shaped)
- [ ] verbspec-typed CLI + MCP surface
- [x] Reusable `workflow_call` Action (`version.yml` + `release-provenance.yml`)
- [ ] Publish to npm + JSR

Tracking: [bounded-systems/string-audit#43](https://github.com/bounded-systems/string-audit/issues/43).

## License

PolyForm-Noncommercial-1.0.0
