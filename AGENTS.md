# Livepeer Agent contribution boundaries

## Product boundaries

- Do not import application code, authentication implementations, generated output, credentials, sessions, or Git history from sibling or private repositories.
- Treat external reference applications as reference material only. Reimplement required behavior against this repository's documented contracts and dependency licenses.
- Livepeer MCP owns Livepeer identity, email verification, and access for each Daydream API key. Do not add a parallel product-auth or entitlement system.
- Never perform paid media calls from tests.
- Never commit `.env` files, credentials, user email addresses, prompts, or session data.

## Package ownership

- `apps/cli`: command entrypoint, local credentials, agent and TUI surfaces.
- `packages/contracts`: frozen cross-package interfaces and test doubles. Contract changes require explicit review.
- `packages/livepeer-client`: transport-neutral MCP client and normalization.
- `packages/model-providers`: Pi model-provider catalog and resolution.

Keep changes within the owning package where possible. Make cross-package contract changes explicit and review them independently.

## Quality gate

Run lint, typecheck, tests, build, and package validation before committing. Tests use fake credential and MCP providers unless a separate live smoke test is explicitly authorized.
