# Livepeer Agent

A terminal-first Livepeer client with a deterministic CLI and a native agent.

Livepeer identity, access, and email verification are owned by `https://agent.livepeer.org/api/mcp`. The CLI supplies one Daydream API key and does not implement a separate product-auth or entitlement service.

## Install

Requires Node.js 22.19 or newer. Install the latest public release without a GitHub account:

```sh
curl -fsSL https://raw.githubusercontent.com/peacenode/livepeer-agent-releases/main/install.sh | sh
```

The installer verifies the release checksum, installs into `~/.local/share/livepeer-agent`, and links both commands into `~/.local/bin`. If that directory is not already on `PATH`, add it in your shell profile.

Starting with `0.1.1`, check for an update or install the latest release from the terminal:

```sh
livepeer update --check
livepeer update
```

Users on `0.1.0` can update by rerunning the one-line installer once; subsequent releases support `livepeer update` directly.

Source development happens in this repository. Stable release artifacts, the installer, and third-party notices are mirrored to [`peacenode/livepeer-agent-releases`](https://github.com/peacenode/livepeer-agent-releases). SHA-256 verification detects a corrupt or mismatched download; because the checksum is hosted beside the archive, it does not independently protect against compromise of the distribution repository or its maintainers.

Pin a release or choose different user-owned directories with environment variables:

```sh
LIVEPEER_AGENT_VERSION=v0.1.0 \
LIVEPEER_AGENT_INSTALL_ROOT="$HOME/.livepeer-agent" \
LIVEPEER_AGENT_BIN_DIR="$HOME/bin" \
sh install.sh
```

Source releases are built without npm by pushing a `v*` tag or running the Release workflow with a version such as `v0.1.0`. The workflow runs the full quality gate before uploading `livepeer-agent.tgz` and its SHA-256 checksum. A maintainer can then mirror those exact verified files to the stable distribution repository with `./scripts/promote-release.sh v0.1.0`.

## Development

Requires Node.js 22.19 or newer and pnpm 10.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm package:validate
```

No real service is contacted by the test suite.

Local environment overrides belong in the ignored `.env.local`, never in `.env.example`. The CLI does not load it automatically; source it only for the command that needs the values:

```sh
set -a
. ./.env.local
set +a
livepeer agent
```

Prefer `livepeer key add` for a Daydream key because it uses the platform credential store instead of a plaintext project file.

## CLI

Build and validate a standalone installable package:

```sh
pnpm build
pnpm package:validate
```

The validator packs the CLI, installs it into a temporary global prefix, and invokes both `livepeer --help` and `livepeer-agent --help`.

Store a Daydream key through the hidden prompt:

```sh
livepeer key add
livepeer key status
```

For temporary local testing, provide the key through the process environment. Avoid writing the value directly in an `export DAYDREAM_API_KEY=...` command because shells commonly retain that command in history:

```sh
read -s DAYDREAM_API_KEY
export DAYDREAM_API_KEY
livepeer agent
unset DAYDREAM_API_KEY
```

The key is sent only to the pinned Livepeer MCP endpoint. A stored key takes precedence over `DAYDREAM_API_KEY`; the CLI fails closed rather than forwarding either key when `LIVEPEER_MCP_URL` overrides that endpoint. The CLI does not automatically load `.env` files.

Email verification belongs to the MCP profile for the current key. In the agent, ask to verify your email; it will call `me_update`, `request_activation`, and then `activate` after you provide the one-time code. Verifying an unrelated website account or a different API key does not activate the current key.

## Access paths

Livepeer Agent supports two explicit MCP-owned paths:

1. **Keyless preview:** run `livepeer`, then say `verify my email`. MCP attaches the email flow to the current keyless profile and unlocks only the preview allowance.
2. **Daydream models:** run `livepeer key add`, restart any already-open agent, then run `livepeer access status`. A successful status reports `credentialApplied: true` and `keyClass: "daydream"`. In the agent, say `verify my email` if MCP requires an email profile for a gated action.

`livepeer access status` reports only safe booleans and state labels; it never prints the API key, email address, or principal ID. Adding and verifying a keyless profile does not unlock Daydream models, and adding a Daydream key does not transfer a profile previously verified under another MCP principal.

Common commands:

```sh
livepeer tools list
livepeer key add
livepeer key status
livepeer access status
livepeer capabilities list --kind ai --limit 10
livepeer tools call <name> --input request.json --yes
livepeer media generate --prompt "A quiet field at sunrise" --yes
livepeer jobs wait <job-id> --interval 2 --timeout 600
livepeer provider add openai
livepeer provider login openai-codex
livepeer browser install
livepeer agent
```

### Browser automation

The agent uses native, stateful browser tools rather than shelling out to `curl` or scraping raw HTML. The tools are backed by a pinned Playwright CLI companion and operate on accessibility snapshots with element refs. Install the companion and managed Chromium build once:

```sh
livepeer browser status
livepeer browser install
```

The standalone CLI stays small and never downloads Chromium during ordinary package installation. Managed browser files live below the Livepeer config directory. Read-only navigation is automatic; interactions that may submit data or change a website require terminal approval. Use a headed browser for login, SSO, or 2FA and enter credentials directly into the browser window.

Model-provider keys are stored in macOS Keychain as separate OpenAI and Anthropic entries. On systems without supported credential storage, the CLI warns before using provider-specific permission-`0600` files. Existing `providers.json` keys are migrated individually and removed from the legacy file after a successful secure write.

`livepeer provider login openai-codex` uses Pi's built-in ChatGPT/Codex OAuth flow. The OAuth credential and refresh state remain on the user's computer in Keychain and never enter Livepeer access, transcripts, or model context. Direct OpenAI API-key access remains available through `livepeer provider add openai`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification requirements. Report security vulnerabilities privately using the instructions in [SECURITY.md](SECURITY.md); do not open a public issue for a suspected vulnerability or exposed credential.

Livepeer Agent is licensed under the [Apache License 2.0](LICENSE). The owned Pi coding-agent fork retains its upstream [MIT license](packages/pi-coding-agent/LICENSE); bundled dependency attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
