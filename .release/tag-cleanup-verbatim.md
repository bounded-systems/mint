---
bump: patch
---
`mint release` no longer dies with `Command failed: git config --get commit.gpgsign` on a machine that has not opted into commit signing — an unset key is the default, not an error. And the release tag is annotated with `--cleanup=verbatim`, so the changelog entry's `## <version>` and `### <bump>` headings survive into the tag and the GitHub release notes; git's default strips every line beginning with `#`, which silently reduced the annotation to bullets on every tag mint has ever cut and merged a multi-section entry's Minor and Patch changes into one undifferentiated list.
