# Upstream provenance

This package is an owned Livepeer shell derived from Pi's coding-agent package.

- Repository: `https://github.com/earendil-works/pi.git`
- Source path: `packages/coding-agent`
- Base commit: `936aff00918de1187f085f123c2812d8f2d67745`
- Upstream version: `0.84.1`
- Filtered subtree commit: `8dc7c9717c6a3ee2682e4a86823522a909298f56`
- Import date: `2026-08-10`
- Livepeer package version: `0.84.1-livepeer.1`

The import excludes Pi's sibling packages. This workspace consumes the exact
`0.84.1` releases of Pi AI, agent-core, TUI, client, and protocol instead.
Upstream npm release locks and binary-release orchestration are intentionally
not part of the private workspace package.

## Updating

Create a temporary clone of upstream, pin the reviewed upstream commit, run
`git subtree split --prefix=packages/coding-agent` without `--squash`, and use
`git subtree pull --prefix=packages/pi-coding-agent` in this repository. Update
both provenance files and the exact Pi dependency cohort in the same review.
