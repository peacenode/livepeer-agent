# Contributing

This repository owns the Livepeer product layer and the branded `@livepeer/pi-coding-agent` shell. The shell is a filtered, history-preserving fork of Pi's `packages/coding-agent`; the remaining Pi packages are exact published dependencies.

## Ownership

- `packages/pi-coding-agent`: generic terminal lifecycle, session handling, approvals, renderer framing, product host ports, boot/composer layout, skills, and themes.
- `packages/terminal-host`: Livepeer tool classification, labels, pricing, result summaries, branded progress, approvals, and routing.
- `packages/contracts`: frozen host interfaces. Change these only when an existing interface cannot represent required behavior.

Do not add Livepeer tool names, pricing parsing, waitlist URLs, or product-specific result formatting to the generic shell.

## Required gates

```sh
pnpm install --frozen-lockfile --ignore-scripts
./scripts/scan-secrets.sh
pnpm check
./test.sh
pnpm build
pnpm --filter @livepeer/pi-coding-agent exec npm pack --dry-run
pnpm package:validate
```

Tests must use fake providers and isolated configuration directories. Do not use real credentials, paid media calls, personal configuration, or external services. Livepeer MCP owns identity, access, and email verification; do not add a parallel product-auth layer to the terminal.

## Credentials and vulnerability reports

- Keep `.env.example` limited to variable names and safe empty placeholders.
- Put temporary local overrides in the ignored `.env.local`; the CLI does not load it automatically.
- Prefer `livepeer key add` and provider login commands over plaintext credential files.
- Never commit credentials, connection URLs containing passwords, session transcripts, user email addresses, or paid-media prompts.
- Report suspected vulnerabilities and exposed credentials privately as described in `SECURITY.md`.

## Updating the Pi shell

Create a temporary clone of the upstream repository, split the new upstream commit with `git subtree split --prefix=packages/coding-agent`, then pull the filtered commit into `packages/pi-coding-agent` without `--squash`. Update `UPSTREAM.md`, `UPSTREAM.json`, the exact Pi dependency cohort, and `THIRD_PARTY_NOTICES.md`. Review the upstream-versus-owned diff before replaying product seams.

Keep upstream tests, fixtures, docs, and examples tracked for maintenance, but exclude tests and source maps from the published package. Port behavior in narrow seams with regression tests; do not bulk cherry-pick an existing branded fork.
