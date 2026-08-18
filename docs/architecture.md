# Livepeer Agent architecture

Livepeer Agent is a first-party terminal agent for Livepeer execution. It uses a maintained
fork of Pi's coding-agent application shell and exact published Pi foundation
packages. The Pi session is the only agent loop in the product path; hosted
planning and agent-delegation operations are not exposed to it.

## Runtime paths

```text
livepeer CLI
├── terminal-host
│   ├── Livepeer tools, browser, approvals, budgets, and resources
│   └── @livepeer/pi-coding-agent (owned application-shell fork)
│       └── @earendil-works Pi 0.84.1 foundations
│           ├── pi-ai
│           ├── pi-agent-core
│           ├── pi-tui
│           ├── pi-client
│           └── pi-protocol
└── livepeer-client
    ├── LivepeerExecutionClient
    └── MCP adapter → https://agent.livepeer.org/api/mcp
```

For an interactive run, the CLI resolves local model credentials and creates a
typed `LivepeerExecutionClient`, then calls `terminal-host`. The current client
implementation uses MCP as its transport adapter. The host creates the owned Pi
shell's model runtime, session manager, resources, tools, agent session, and
interactive mode. Livepeer-specific tool and browser definitions are injected
through those shell APIs rather than through a parallel agent implementation.

The execution client contains capability, pricing, profile, access, asset,
media, deterministic project, and durable job operations. It deliberately has
no operation for `submit_agent_task`, `submit_creative_job`, `auto_plan`, or
another server-side reasoning loop. The terminal agent interprets goals,
selects capabilities, supplies explicit project scenes, and decides sequencing.

Deterministic commands use `livepeer-client` to call the same service
without starting the interactive shell.

## Ownership boundaries

| Owner | Responsibilities |
| --- | --- |
| Livepeer service | Livepeer identity and access, email verification, capability execution, jobs, server-side policy, and usage enforcement |
| `LivepeerExecutionClient` | Typed first-party boundary for capabilities, execution, assets, identity, pricing, and durable job state; MCP is one adapter |
| Livepeer terminal | Goal interpretation, capability selection and sequencing, local Daydream and model credentials, CLI commands, terminal interaction, browser tooling, local sessions, approvals, budgets, and presentation |
| Owned Pi shell fork | Interactive application lifecycle, sessions and compaction, extension/resource loading, tool execution, model orchestration, and TUI behavior |
| Published Pi foundations | AI/provider abstractions, the agent core, terminal UI primitives, client protocol, and RPC protocol |

Livepeer access remains owned by the Livepeer service. The terminal must not add a
parallel product account, invitation, entitlement, gateway-session, or email
verification system. Model-provider OAuth is separate: it is stored locally
and is used only to access the selected model provider.

## What is forked

Only Pi's `packages/coding-agent` source is forked into
`packages/pi-coding-agent`. The import preserves upstream Git history and is
pinned to commit `936aff00918de1187f085f123c2812d8f2d67745` (Pi `0.84.1`).
The filtered source commit is `8dc7c9717c6a3ee2682e4a86823522a909298f56`.

The five `@earendil-works` foundation packages are not copied into this
repository. They are pinned package dependencies at `0.84.1`. This distinction
lets maintainers update the general foundations normally while reviewing the
application-shell fork as source.

The machine-readable record is
[`packages/pi-coding-agent/UPSTREAM.json`](../packages/pi-coding-agent/UPSTREAM.json).

## Updating Pi

1. Clone `https://github.com/earendil-works/pi.git` into a temporary directory
   and check out the reviewed upstream commit.
2. Run `git subtree split --prefix=packages/coding-agent -b coding-agent` in
   that clone. Do not use `--squash`.
3. Add the temporary clone as a local remote in this repository and run
   `git subtree pull --prefix=packages/pi-coding-agent <remote> coding-agent`.
4. Remove the temporary remote. Update `UPSTREAM.md`, `UPSTREAM.json`, the five
   exact Pi foundation versions, and the downstream package version together.
5. Review downstream conflicts explicitly and run the full offline quality
   gate before merging the update.

Do not replace the fork with a fresh file copy: doing so loses the lineage that
makes upstream changes and downstream deltas reviewable.
