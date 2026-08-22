---
bump: patch
---
`release-cut.yml` writes the changelog entry as the tag annotation instead of the tag name, so a CI-cut release gets the same GitHub release notes a laptop cut does. Both release workflows publish with `--notes-from-tag`, so the annotation *is* the notes; the text is read out of the release Statement the cut already derives, making it byte-identical to the entry that Statement attests.
