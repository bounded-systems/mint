---
bump: patch
---
The release tag is annotated with `--cleanup=verbatim`, so the changelog entry's `## <version>` and `### <bump>` headings survive into the tag and the GitHub release notes. git's default strips every line beginning with `#`, which silently reduced the annotation to bullets on every tag mint has ever cut — laptop cuts included — and merged a multi-section entry's Minor and Patch changes into one undifferentiated list.
