---
bump: minor
---
mint adopts its own `release-cut`: a new `cut` workflow dispatches the tag cut in CI and chains `release.yml` as a dependent job, so a release no longer needs a laptop. `release.yml` gains a `workflow_call` trigger and a `tag` input; its `push: tags` trigger is unchanged, so a locally-cut release still works.
