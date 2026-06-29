# Changelog

## 0.4.10 — 2026-06-29

### Patch

- unify npm + JSR behind a single publish job gated by the npm-publish GitHub Environment — one approval deploys to all registries

## 0.4.9 — 2026-06-29

### Patch

- replace npm staged publishing with direct npm publish gated behind the GitHub Environment approval — same human gate, no dependency on unfinished npm staging OIDC support

## 0.4.8 — 2026-06-29

### Patch

- fix npm stage publish OIDC scope — move npm stage publish into the npm-approve job (environment: npm-publish) so the OIDC token carries the environment claim required by the trusted publisher

## 0.4.7 — 2026-06-29

### Patch

- retry staged npm publish — trusted publisher now has stage action + environment scoped to npm-publish

## 0.4.6 — 2026-06-29

### Patch

- bump actions/attest-build-provenance to v4.1.1 (Node 24, clears deprecation warnings); add npm-publish GitHub Environment gate with required reviewer before surfacing the npm stage approve command

## 0.4.5 — 2026-06-29

### Patch

- fix registry existence check — use curl instead of `npm view` (NODE_AUTH_TOKEN in .npmrc was causing the lookup to fail, always falling through to first-publish path)

## 0.4.4 — 2026-06-29

### Patch

- first staged npm release — package now seeded, all future releases go through `npm stage publish` with human 2FA approval

## 0.4.3 — 2026-06-29

### Patch

- seed npm first publish — detect new package and fall back to `npm publish` before staging is available

## 0.4.2 — 2026-06-29

### Patch

- retry staged npm publish — trusted publisher updated to allow staging

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

