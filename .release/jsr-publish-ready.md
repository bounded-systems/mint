---
bump: patch
---
publish-prep: make the package cleanly JSR-publishable — `jsr.json` gains the SPDX `license` + a `publish.include` allowlist (tarball = exports + mint.mjs + README + CHANGELOG); `@types/node` dev dependency so the JSR type-checker resolves the `node:` imports. `npx jsr publish --dry-run` and `deno publish --dry-run` both pass.
