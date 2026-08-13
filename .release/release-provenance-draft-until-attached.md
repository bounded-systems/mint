---
bump: minor
---
release-provenance: create the GitHub release as a draft and publish it only once assets are attached, so a separate binaries job can no longer hit `422: Cannot upload assets to an immutable release`; adds `assets-artifact` (attach a caller artifact from the same run) and `finalize` inputs
