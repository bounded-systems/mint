# Changelog

## 0.4.1 — 2026-06-29

### Patch

- fix publish logging — stream npm stage output so errors are visible in CI (was silently swallowed by set -e)

## 0.4.0 — 2026-06-29

### Minor

- staged npm publishing — `npm stage publish` replaces direct publish; human 2FA approval gate before the package goes live

## 0.3.1 — 2026-06-29

### Patch

- release: JSR publish must not be blocked by the brand-new-npm-package step (continue-on-error)

## 0.3.0 — 2026-06-29

### Minor

- mint release: cut the tag + emit a deterministic in-toto release Statement (tag → version plan → commit), keyless-signed in CI (cosign/Sigstore; anchored-chain-shaped); `mint attest` re-emits it; reusable release-provenance.yml workflow_call for consumers

### Patch

- publish-prep: make the package cleanly JSR-publishable — `jsr.json` gains the SPDX `license` + a `publish.include` allowlist (tarball = exports + mint.mjs + README + CHANGELOG); `@types/node` dev dependency so the JSR type-checker resolves the `node:` imports. `npx jsr publish --dry-run` and `deno publish --dry-run` both pass.

## 0.2.0 — 2026-06-24

### Minor

- mint release verb (signed tag) + SLSA provenance release workflow

## 0.1.0 — 2026-06-24

### Minor

- Deterministic plan core (pure intents+version→version+changelog) + Zod intent contract + CLI (plan/version)
- Reusable version.yml workflow + org adoption scanner (--write rollout)

