# Livepeer CLI

The deterministic CLI and terminal-agent entrypoint. Both `livepeer` and `livepeer-agent` invoke the same binary.

Requires Node.js 22.19 or newer. The published tarball is a standalone bundle. The agent loads user-owned skills and extensions from `.livepeer` in the current repository and from the Livepeer config directory; it does not include a hidden director profile or bundled production skills.

Install the latest checksummed GitHub release without npm by following the one-line private-repository command in the [workspace README](../../README.md#install).

```sh
livepeer --help
livepeer tools list --json
livepeer capabilities list --limit 10
livepeer provider add anthropic
livepeer browser install
livepeer agent --resume
```

## Managed browser

The terminal agent has native browser tools for opening JavaScript applications, reading accessibility snapshots, interacting through Playwright element refs, and capturing screenshots. Browser navigation and reading are automatic; clicks, form input, selections, and other actions that may change external state use the terminal approval flow.

Browser support is installed explicitly because Chromium is much larger than the standalone CLI package:

```sh
livepeer browser status
livepeer browser install
```

The command installs a pinned `@playwright/cli` companion and its matching Chromium build under the Livepeer config directory. Browser binaries, daemon state, profiles, cookies, and screenshot files are not written into the current repository. A screenshot requested by the agent is returned to the model and becomes part of that agent session, so avoid capturing pages containing secrets. Re-run `livepeer browser install --force` to repair or replace the managed companion.

When a website requires login, SSO, or 2FA, ask the agent to open it in a visible browser. Complete authentication in the browser window; do not paste passwords or one-time codes into agent chat. The persistent browser profile is local credential material and must never be committed or shared.

Store a Livepeer MCP API key using a hidden terminal prompt:

```sh
livepeer key add
livepeer key status
livepeer access status
```

The key is stored in macOS Keychain when available, with a permission-`0600` local fallback on other systems. Use `livepeer key remove` to delete it. For automation, `--stdin` and `--from-env` are available; avoid command-line key arguments and never paste a key into agent chat.

Anonymous commands use `https://agent.livepeer.org/api/mcp` when no key is configured. A stored or environment Daydream key authenticates directly to that endpoint. Email verification is performed by the MCP `me_update`, `request_activation`, and `activate` tools and is attached to the current key; the CLI has no separate Livepeer login or account session.

Check for or install a newer public terminal release:

```sh
livepeer update --check
livepeer update
```

Use `livepeer access status` after adding a key or completing verification. It safely distinguishes keyless preview, a keyless profile, an applied Daydream key, a Daydream key with a profile, and a configured key that MCP did not receive. It does not print credentials, email addresses, or principal IDs.
