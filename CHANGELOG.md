# Changelog

## 0.8.0 — 2026-08-23

### Minor

- npm-publish.yml — a reusable npm publish lane, and one prescribed release entry point per repo (npm validates the CALLING workflow)

## 0.7.2 — 2026-08-22

### Patch

- `mint release` no longer dies with `Command failed: git config --get commit.gpgsign` on a machine that has not opted into commit signing — an unset key is the default, not an error. And the release tag is annotated with `--cleanup=verbatim`, so the changelog entry's `## <version>` and `### <bump>` headings survive into the tag and the GitHub release notes; git's default strips every line beginning with `#`, which silently reduced the annotation to bullets on every tag mint has ever cut and merged a multi-section entry's Minor and Patch changes into one undifferentiated list.

## 0.7.1 — 2026-08-22

### Patch

- `release-cut.yml` writes the changelog entry as the tag annotation instead of the tag name, so a CI-cut release gets the same GitHub release notes a laptop cut does. Both release workflows publish with `--notes-from-tag`, so the annotation *is* the notes; the text is read out of the release Statement the cut already derives, making it byte-identical to the entry that Statement attests.

## 0.7.0 — 2026-08-22

### Minor

- Relicensed to MIT (org license tiering, #34). The manifests changed in the 0.6.0 bump, but 0.6.0 was manifest-only and was never tagged or published — 0.7.0 is the first release that actually ships under MIT. Everything up to and including 0.5.0 remains under PolyForm-Noncommercial-1.0.0.
- `release-provenance.yml` takes a `tag` input, so it can be chained after `release-cut.yml`. It defaults to the triggering ref, leaving the `on: push: tags` path every consumer uses today byte-identical; a chained caller passes the cut tag rather than getting the branch.
- mint adopts its own `release-cut`: a new `cut` workflow dispatches the tag cut in CI and chains `release.yml` as a dependent job, so a release no longer needs a laptop. `release.yml` gains a `workflow_call` trigger and a `tag` input; its `push: tags` trigger is unchanged, so a locally-cut release still works.
- release-provenance: create the GitHub release as a draft and publish it only once assets are attached, so a separate binaries job can no longer hit `422: Cannot upload assets to an immutable release`; adds `assets-artifact` (attach a caller artifact from the same run) and `finalize` inputs

## 0.5.0 — 2026-07-05

### Minor

- read + bump `deno.json` (not just `package.json`/`jsr.json`) — unblocks every Deno/JSR package in the org from adopting mint (fixes #13; unblocks gh-project-room#47)

### Patch

- docs: document the minimumDependencyAge 24h JSR/npm cooldown for consumers and its batch-rollout ripple (#11)

## 0.4.15 — 2026-06-29

### Patch

- add repository field to package.json — required by npm provenance verification to match the GitHub repo URL in the OIDC claims

## 0.4.14 — 2026-06-29

### Patch

- revert _authToken strip — the empty NODE_AUTH_TOKEN reference in .npmrc is what triggers npm's OIDC exchange; stripping it causes ENEEDAUTH; trusted publisher config (no environment, publish allowed) is the real fix

## 0.4.13 — 2026-06-29

### Patch

- fix npm OIDC auth — restore registry-url and strip the injected empty _authToken before publishing so npm can fall through to its OIDC trusted-publishing exchange

## 0.4.12 — 2026-06-29

### Patch

- remove registry-url from npm job setup-node — injected NODE_AUTH_TOKEN conflicts with OIDC trusted publishing auth exchange

## 0.4.11 — 2026-06-29

### Patch

- split publish into approve (gate) + npm + jsr as independent parallel jobs — one approval unblocks all deploys, each target has its own job log and can be retried independently

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

