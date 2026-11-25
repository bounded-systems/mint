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

## First release

`mint version` and `mint release` read different inputs, and a brand-new repo
needs only what `mint release` reads ([#17](https://github.com/bounded-systems/mint/issues/17),
[#18](https://github.com/bounded-systems/mint/issues/18)):

- **`mint plan` and `mint version` read `.release/` intents.** With none, the plan
  has `bump: null`: `mint version` changes nothing, and both commands print
  "nothing to release" (`mint plan --json` prints the plan instead)
  ([`plan.mjs` L77–80](plan.mjs#L77-L80),
  [`mint.mjs` L63–70 and L78–81](mint.mjs#L63-L81)).
- **`mint release` does not read `.release/`.** It tags the version already in the
  manifest, taken from the first of `deno.json`, `jsr.json`, `package.json` that
  declares one ([`mint.mjs` L44–58](mint.mjs#L44-L58)). The tag annotation is
  that version's `## <version>` section of `CHANGELOG.md`; with no such section
  it stops with ``no CHANGELOG.md entry for <version> — run `mint version` first.``
  ([`mint.mjs` L148–155](mint.mjs#L148-L155), [`plan.mjs` L60–71](plan.mjs#L60-L71)).

All three commands need a manifest with a `version`: without one they fail with
`no manifest with a version field` ([`mint.mjs` L46–58](mint.mjs#L46-L58)). It
must be semver: `mint plan` and `mint version` validate it as such
([`plan.mjs` L22](plan.mjs#L22)), and `mint release` refuses a tag that is not
`v<semver>` ([`release.mjs` L55–57](release.mjs#L55-L57)). So release #1 takes
one of two paths.

**Hand-seed.** Write the first version and its changelog section yourself, then
commit and release. In `package.json` (or `deno.json` / `jsr.json`) set
`"version": "0.1.0"`, and start `CHANGELOG.md` with:

```markdown
# Changelog

## 0.1.0 — 2026-11-25

- First release.
```

```sh
git add package.json CHANGELOG.md && git commit -m "Version 0.1.0"
mint release --dry-run   # preview the tag and the statement; touches nothing
mint release
```

**Intent path.** Seed a base version, add one intent, and let `mint version`
write the rest. Set `"version": "0.0.0"` in the manifest and add
`.release/first-release.md`:

```markdown
---
bump: minor
---
First release.
```

```sh
mint plan                # preview: 0.0.0 → 0.1.0 (minor)
mint version             # bumps every manifest present + package-lock.json, writes
                         # CHANGELOG.md (creating it if absent), deletes the intent
git add -A && git commit -m "Version 0.1.0"
mint release
```

The seed plus the intent's `bump` decides the first number, because `mint
version` bumps with `semver.inc`: `0.0.0` + `minor` gives `0.1.0`
([`plan.mjs` L81](plan.mjs#L81), [`mint.mjs` L83–120](mint.mjs#L83-L120)).

Either path ends in `mint release`, which refuses to run when the tag already
exists or the working tree is dirty, so commit first
([`mint.mjs` L222–224](mint.mjs#L222-L224)).

**Cutting it in CI instead.** A `workflow_dispatch` caller of
[`release-cut.yml`](.github/workflows/release-cut.yml) (mint's own `release.yml`
is one) runs its own guards before it tags: the tag must not exist (L250–261),
`mint plan` must report "nothing to release" (L266–275), and the changelog
section must exist (L281–288). On the intent path, then, the `mint version`
commit has to be **merged** before you dispatch; an intent still in `.release/`
fails the cut. `dry-run` defaults to `true`
([`release-cut.yml` L118–121](.github/workflows/release-cut.yml#L118-L121),
[`release.yml` L57–60](.github/workflows/release.yml#L57-L60)): dispatch once to
watch every check pass, then again with it unchecked.

### The tag push needs an identity allowed to create `v*` tags

Both doors create the tag with `git tag` and push it with `git push`, under
whatever credential the pushing git process holds:

| Door | Creates the tag | Pushes it |
| --- | --- | --- |
| `mint release` from a checkout | `git tag` ([`mint.mjs` L231](mint.mjs#L231)) | `git push <remote> <tag>` with your git credentials ([`mint.mjs` L237](mint.mjs#L237)) |
| `workflow_dispatch` → `release-cut.yml` | `git tag -a` ([`release-cut.yml` L331](.github/workflows/release-cut.yml#L331)) | `git push origin "$TAG"` with the job's token, granted `contents: write` ([`release-cut.yml` L133–134 and L332](.github/workflows/release-cut.yml#L133-L332); [`release.yml` L74–75](.github/workflows/release.yml#L74-L75)) |

mint does not create tags through the GitHub API, and it does not check in
advance whether the push will be accepted. If your org or enterprise restricts
who may create tags, **the pushing identity in that table must be allowed to
create `v*` tags before your first release**. #18 suggests making it a ruleset
bypass actor, such as a release App or bot. Otherwise the push is refused, as
`bounded-systems/repo-health`'s first release was
([#17](https://github.com/bounded-systems/mint/issues/17)):

```text
! [remote rejected] v0.1.0 -> v0.1.0 (Cannot create ref due to creations being restricted)
```

What a refused push leaves behind on the checkout door:

- **The tag exists locally**, and so does `v<version>.intoto.json`, because both
  are written before the push ([`mint.mjs` L231–237](mint.mjs#L231-L237)).
  Running `mint release` again stops at `tag v<version> already exists`
  ([`mint.mjs` L223](mint.mjs#L223)). Either push that same tag with a
  permitted identity (`git push origin v<version>`), or delete both before
  trying again: `git tag -d v<version>` and `rm v<version>.intoto.json`. The
  statement file is untracked, so if it stays, the re-run stops at `working tree
  not clean` instead ([`mint.mjs` L207 and L224](mint.mjs#L207-L224)).
- **Nothing downstream ran.** `release.yml`'s GitHub release, SLSA attestation
  and signed Statement run only once the tag reaches GitHub
  ([`release.yml` L48–50 and L117–180](.github/workflows/release.yml#L48-L180)),
  and so does an adopter's `release-provenance.yml` caller
  ([its header, L1–19](.github/workflows/release-provenance.yml#L1-L19)).

To cut the tag on your machine but have a permitted identity push it, split the
two steps with `--no-push` ([`mint.mjs` L189 and L237](mint.mjs#L189-L237)):

```sh
mint release --no-push   # create the tag and write the statement; push nothing
git push origin v0.1.0   # run under the credential your rules permit
```

On the CI door, a tag pushed with the workflow's `GITHUB_TOKEN` starts no other
workflow runs. That is why `release.yml` chains its publish jobs after `cut`
rather than waiting for the tag push to trigger them
([`release.yml` L31–34](.github/workflows/release.yml#L31-L34),
[`release-cut.yml` L35–44](.github/workflows/release-cut.yml#L35-L44)).

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

#### Shipping extra assets (binaries) on the same release

The release is created as a **draft** and published only once its assets are
attached. A published release is immutable, so anything that attaches *after*
the release goes public fails with `422: Cannot upload assets to an immutable
release` — which is how drift-gate v0.2.0 shipped with no binaries.

So build the assets in a job of the *same* workflow and hand the artifact to
`assets-artifact`; the release job attaches them with the provenance and
publishes once. A separate tag-triggered workflow racing for the same release is
the thing to avoid — it is unordered by construction.

```yaml
permissions: { contents: write, id-token: write, actions: read } # actions: read — artifact download
jobs:
  binaries:
    runs-on: ubuntu-latest
    steps:
      # ... compile into dist/ ...
      - uses: actions/upload-artifact@<sha>
        with: { name: release-binaries, path: dist/* }
  release:
    needs: binaries
    uses: bounded-systems/mint/.github/workflows/release-provenance.yml@<sha>
    with: { ref: <sha>, assets-artifact: release-binaries }
```

If a repo must keep a separate attach workflow, pass `finalize: false` so this
job leaves the draft for that workflow to publish — but that only moves the
finish line, it does not order the two workflows.

## Publish (npm + JSR)

mint ships from [`release.yml`](.github/workflows/release.yml) via **OIDC trusted
publishing** — no `NPM_TOKEN`, no JSR token, ever. That one file is the whole
release entry point: dispatch it to cut the tag in CI, or let it fire on a `v*` tag
cut from a checkout. It is one file rather than two because **npm validates the
entry workflow's filename, not the file containing `npm publish`**, and a package
gets exactly one trusted publisher — so a repo may have exactly one entry workflow
that reaches npm. That convention, and the npm form values it makes uniform, are in
[docs/npm-trusted-publishing.md](docs/npm-trusted-publishing.md); the lane itself is
the reusable [`npm-publish.yml`](.github/workflows/npm-publish.yml), which consumers
call instead of hand-rolling a publisher. The package manifests are kept in lockstep by
`mint version` (it bumps `package.json`, `package-lock.json`, **and** `jsr.json`).

**npm uses a GitHub Environment gate** — both the `npm` and `jsr` jobs declare the
`npm-publish` environment, which requires a designated reviewer to approve in the
GitHub Actions UI before either registry sees anything. The gate sits on the
publishing jobs themselves rather than on a no-op `approve` job upstream, because
that is the only way the `environment` claim reaches the OIDC token — and that
claim is what npm's trusted-publisher **Environment** field pins. Approve at:

```
https://github.com/bounded-systems/mint/actions
```

Once approved, the package publishes immediately via OIDC trusted publishing (no token).

**JSR publishes immediately** on the same tag (no staging concept on JSR).

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

### Consumers: the 24h JSR/npm cooldown after a release

Every fresh JSR/npm publish immediately hits Deno's
[`minimumDependencyAge`](https://docs.deno.com/runtime/packages/supply_chain/)
in any consumer running Deno 2.9+: since 2.9 it defaults to **24 hours** — Deno
refuses to resolve a version published inside that window, full stop, no
config needed to trigger it. It's a real supply-chain guard (malicious
versions are usually caught/yanked within days), but it applies to first-party
`@bounded-systems/*` releases exactly the same as to a random third party.

Concretely: `baobab@0.2.0` published, and every downstream consumer's CI
(e.g. a `check-contrast.yml` caller) hard-failed for the next 24h trying to
resolve it — not a flake, a guaranteed wait baked into every release
([bounded-systems/mint#11](https://github.com/bounded-systems/mint/issues/11)).
For one package that's a wait; for a coordinated rollout of several
interdependent `@bounded-systems/*` packages in one sitting, it ripples —
every consumer of every package in the batch eats the same 24h, and chains of
dependencies compound it.

**The fix does NOT live in a consumer's `deno.json`.** An earlier version of
this doc claimed a `minimumDependencyAge.exclude` list there would work —
that was wrong, and only looked right because it was tested against Deno
2.8.3 (which doesn't enforce the 24h default at all; the default only started
in 2.9). Verified against the real `2.9.1` binary: `deno.json` is never even
read when `deno run`'s entrypoint is a bare `jsr:...` specifier — config-file
discovery only applies in normal "project mode." Planting invalid JSON in a
`deno.json` and confirming Deno never complained is what exposed this.

**What actually works:** the `--minimum-dependency-age` CLI flag on the
invocation itself. That means the fix has to live wherever the `deno run`
command is composed — for a reusable GitHub Actions workflow like
`check-contrast.yml`, that's an input on the workflow, not something a caller
can override from its own repo
([bounded-systems/baobab#7](https://github.com/bounded-systems/baobab/pull/7)
adds `minimum-dependency-age`, defaulting to `"0"`, since the only thing that
workflow ever resolves from the network is `@bounded-systems/baobab` itself —
a first-party package the caller already trust-bounds via its own version
range input, so the age gate adds no real protection there). Any other
reusable workflow or script that shells out to `deno run jsr:...`/`npm:...`
directly needs the same treatment: an explicit `--minimum-dependency-age`
(or `--minimum-dependency-age=0` if every dependency it touches is
first-party) on the command, not a config file a caller drops in.

This still doesn't scale past a handful of hand-fixed workflows — #11 is the
open ask for mint to own generating this consistently across every
`@bounded-systems/*` reusable workflow, rather than fixing each one by hand
as it's hit.

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
- [x] Publish to npm (GitHub Environment approval gate) + JSR

Tracking: [bounded-systems/string-audit#43](https://github.com/bounded-systems/string-audit/issues/43).

## License

MIT
