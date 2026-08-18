# Livepeer Pi shell

This package is Livepeer Agent's owned application shell. It is a
history-preserving fork of Pi's `packages/coding-agent`; it is not the upstream
Pi CLI and is not published as a replacement for Pi.

The production terminal imports this package as an SDK. `terminal-host`
constructs Pi's model runtime, resource loader, session manager, agent session,
and interactive mode, then injects Livepeer-owned tools, browser support,
approval policy, budgets, resources, and presentation.

## Lineage

- Upstream repository: <https://github.com/earendil-works/pi>
- Upstream source: `packages/coding-agent`
- Reviewed base commit: `936aff00918de1187f085f123c2812d8f2d67745`
- Imported subtree commit: `8dc7c9717c6a3ee2682e4a86823522a909298f56`
- Upstream version: `0.84.1`
- Downstream version: `0.84.1-livepeer.1`

The fork contains the application-shell code only. Its lower-level foundations
remain exact published dependencies at version `0.84.1`:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-client`
- `@earendil-works/pi-protocol`

[`UPSTREAM.md`](UPSTREAM.md) and [`UPSTREAM.json`](UPSTREAM.json) are the
canonical provenance records. Update those records and the five dependency
versions together whenever the fork moves to a reviewed upstream commit.

## Downstream ownership

Livepeer owns the integration seams around the fork, including:

- product configuration, naming, boot experience, and local session location;
- dependency-injected model credentials and model selection;
- Livepeer MCP tool registration, approval policy, and per-operation budgets;
- browser tools and bundled OAuth module registration;
- Livepeer resources and terminal presentation.

Upstream Pi supplies the general coding-agent machinery preserved in the fork:
sessions, compaction, extensions, tools, resource loading, model orchestration,
and the interactive TUI. Downstream changes to those internals should either
remain a small documented delta or be proposed upstream.

See the repository's [architecture guide](../../docs/architecture.md) for the
complete runtime and ownership boundaries.

## Upstream reference documentation

The files in [`docs/`](docs/) and the package changelog are retained from the
reviewed Pi import as upstream reference material. They may describe upstream
Pi commands, authentication, configuration paths, telemetry, or distribution
that do not apply to Livepeer Agent. For upstream behavior at the imported
revision, use the
[original README](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/packages/coding-agent/README.md).

## Updating the fork

Follow the history-preserving subtree procedure in [`UPSTREAM.md`](UPSTREAM.md).
Review the upstream diff, run the full offline quality gate, and record any
Livepeer conflict resolutions in the update commit.
