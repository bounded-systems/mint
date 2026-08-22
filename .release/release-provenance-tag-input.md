---
bump: minor
---
`release-provenance.yml` takes a `tag` input, so it can be chained after `release-cut.yml`. It defaults to the triggering ref, leaving the `on: push: tags` path every consumer uses today byte-identical; a chained caller passes the cut tag rather than getting the branch.
