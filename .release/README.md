# Release intents

One file per user-facing change, added in the PR that makes the change. `mint`
collects every `*.md` here (except this README and `_`/`.`-prefixed files),
resolves the strongest `bump`, and cuts the release deterministically.

Format:

```markdown
---
bump: minor   # patch | minor | major
---
scan: promote to a verb (CLI + MCP) + shared Zod type contracts
```

- `mint plan` — preview the next version + changelog entry (pure; pass `--date` to pin it).
- `mint version` — apply: bump `package.json` + lockfile, prepend `CHANGELOG.md`, consume these intents.
- `mint release` — cut + sign the tag *(coming soon)*.
