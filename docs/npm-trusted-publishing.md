# npm trusted publishing: the caller convention

npm's trusted publishing replaces `NPM_TOKEN` with the job's short-lived GitHub
Actions OIDC token. Configuring it takes four values, and two of them are only
obvious once a release has already failed.

This document is the org convention. It exists because three repos wrote three
different publish workflows in one evening and none of them agreed
([mint#48](https://github.com/bounded-systems/mint/issues/48)).

## The two facts that decide the architecture

**1. npm validates the ENTRY workflow, not the file containing `npm publish`.**
From npm's docs:

> Some GitHub Actions workflows use `workflow_call` to invoke other workflows
> that run `npm publish`… When this happens, validation checks the **calling
> workflow's name** instead of the workflow that actually contains the publish
> command, which can cause configuration mismatches.

**2. Each package can have exactly one trusted publisher configured at a time.**

Together they rule out the shape everyone reaches for. mint's release
architecture *requires* chaining — a tag pushed by `GITHUB_TOKEN` triggers no
workflow, so the cut and the publish must be jobs of one run — and chaining means
the entry workflow is what npm sees. With one publisher slot per package, a repo
whose triggers are spread across several files can register only one of them:

| entry point | what npm validates |
| --- | --- |
| `cut.yml` dispatch → chains `publish.yml` (the normal release) | `cut.yml` |
| direct dispatch of `publish.yml` (recovery for a half-shipped release) | `publish.yml` |
| tag push → `publish.yml` (a laptop cut) | `publish.yml` |

Two of those three paths are then broken, and the breakage is invisible until a
release dies with `ENEEDAUTH` **after the tag is already pushed**.

## The convention

> **`.github/workflows/release.yml` is the single npm entry point, in every
> repo, and the publish runs in the `npm-publish` GitHub Environment.**

Every trigger that must reach npm lives in that one file — the tag push from a
laptop cut, the dispatch that cuts in CI, and the recovery dispatch for a
half-shipped release. Nothing else in `.github/workflows/` may run `npm publish`
or call the publish lane.

The npm form is then the same table for every package in the org:

| npm field | value |
| --- | --- |
| Organization or user | the repo owner (`bounded-systems`, `bdelanghe`, …) |
| Repository | the repo name |
| Workflow filename | `release.yml` |
| Environment | `npm-publish` |

Pinning the Environment is what turns the reviewer gate into something npm can
verify. The `environment` claim only appears in the OIDC token of a job that
*itself* declares `environment:` — a separate no-op `approve` job upstream does
not put it there. A job with `uses:` cannot carry `environment:` at all, which is
why [`npm-publish.yml`](../.github/workflows/npm-publish.yml) takes it as an
input and declares it internally.

## The caller

```yaml
# .github/workflows/release.yml
name: release
on:
  push: { tags: ["v*"] }
  workflow_dispatch:
    inputs:
      expect-version: { type: string, required: false }
      dry-run:        { type: boolean, default: true }
permissions: { contents: read }
jobs:
  cut:
    if: github.event_name == 'workflow_dispatch'
    permissions: { contents: write }
    uses: bounded-systems/mint/.github/workflows/release-cut.yml@<sha>
    with:
      expect-version: ${{ inputs.expect-version }}
      dry-run: ${{ inputs.dry-run }}

  resolve:                       # one tag for both paths; see release.yml's header
    needs: [cut]
    if: ${{ !cancelled() && (github.event_name == 'push' || needs.cut.outputs.cut == 'true') }}
    runs-on: ubuntu-latest
    outputs: { tag: "${{ steps.tag.outputs.tag }}" }
    steps:
      - id: tag
        env: { CUT_TAG: "${{ needs.cut.outputs.tag }}", REF: "${{ github.ref_name }}" }
        run: echo "tag=${CUT_TAG:-$REF}" >> "$GITHUB_OUTPUT"

  npm:
    needs: resolve
    if: ${{ !cancelled() && needs.resolve.result == 'success' }}   # see below — load-bearing
    permissions: { contents: read, id-token: write }
    uses: bounded-systems/mint/.github/workflows/npm-publish.yml@<sha>
    with:
      tag: ${{ needs.resolve.outputs.tag }}
```

Every job downstream of `cut` carries a **status function**, and that is not
stylistic. `cut` is skipped on two of the three doors, and GitHub propagates a
skip through the entire `needs` closure — so a job with `needs: resolve` and no
`if:` at all is skipped too, even though `resolve` succeeded. `resolve`'s
`!cancelled()` clears the taint for `resolve` alone, and a plain condition
clears it for nobody. Omit these and the release goes green having published
nothing; a dry run cannot tell you, because it skips those same jobs on purpose.
This cost four repos their tag-push path before site-mcp#43 found it.

`permissions` on the calling job is validated as a **union** with what the called
workflow declares, at **load time**, before any `if:` runs. Withholding one
produces `startup_failure` for the whole run rather than a skipped job
(site-mcp#36).

## What the lane owns, and why each piece is there

Every item below is a defect that reached a release.

- **npm ≥ 11.5.1 and Node ≥ 22.14.0, asserted — never installed.** Node 22 ships
  npm 10.x, which is below the floor; Node 24 ships past it. `npm install -g
  npm@latest` in a release path is how npm v12 arrived unannounced and killed a
  publish: v12 disables remote-tarball dependencies by default, so `npm ci` died
  with `EALLOWREMOTE` before anything shipped (site-mcp#38). The floor is a
  property of the runner image — check it and fail loudly, do not pull an
  unreviewed npm into the one job holding a publishing credential.
- **`package-manager-cache: false`** on `setup-node`. npm's own guidance for
  release builds: a restored cache can seed the publish with dependency state no
  lockfile resolution produced.
- **Every checkout pinned to the tag.** On a chained run the event is
  `workflow_dispatch` on a *branch*, so `github.ref_name` is the branch — an
  unpinned checkout publishes `main` under a version tag's name (site-mcp#34).
  The lane also refuses a tag whose `package.json` version disagrees with it.
- **Idempotent.** A partial release must be recoverable by re-dispatching the
  entry workflow, and npm refuses to republish an existing version. An
  already-published version is a skip, not a failure — site-mcp#38 went red for
  the one registry that had in fact succeeded.
- **`--provenance`.** Free with trusted publishing on a public repo.

## Private repos get no provenance

Sigstore provenance requires a public source repository. `npm publish
--provenance` fails in a private repo even with trusted publishing working
correctly. Pass `provenance: false` rather than debugging it.

## First publish: OIDC cannot create a package

A trusted publisher can only be configured on a package that already exists on
npm, and OIDC cannot create one
([npm/cli#8544](https://github.com/npm/cli/issues/8544)). The first version of a
new package has to be published with a granular access token — after which the
token is deleted and the trusted publisher configured for every release after
it. Nothing about that first step belongs in this lane.
