# Open WebCode UI

A self-hosted AI platform: a powerful, provider-agnostic interface for AI with a chat mode, and the definitive agentic coding platform. Extensible, feature-rich, user-friendly, and built to run entirely offline.

## Highlights

- **Chat mode**: a conversational interface for any model.
- **Agentic coding**: an agent works in per-project workspaces with a terminal, git, checkpoints, skills, and memory.
- **Offline-first**: run fully air-gapped with local models, or connect to cloud providers when you want to.
- **Self-hosted**: your data stays in your `DATA_DIR` (SQLite, workspaces, checkpoints). Stored secrets are encrypted.
- **Multi-user**: SAML single sign-on, WebAuthn passkeys, TOTP, and a superadmin admin account.

## Providers and protocols

Use local and cloud models interchangeably, side by side.

| Kind | Integrations |
| --- | --- |
| Local | Ollama, LM Studio, any OpenAI-compatible server (vLLM, llama.cpp, etc.) |
| Cloud | OpenAI, Anthropic, Google Gemini, Vertex AI, Mistral, Azure OpenAI, Amazon Bedrock |
| Protocols | OpenAI-compatible API, native provider APIs, MCP (Streamable HTTP) |

**MCP** servers extend the agent with external tools. Remote servers over HTTPS are supported.

## Use it as a provider (API server)

Besides calling providers, the server can be one: OpenAI-compatible clients can use `POST /v1/chat/completions` and `GET /v1/models` with any model set up here.

- **Off by default.** An administrator turns it on via `PUT /api/admin/api-settings` (`{"enabled": true}`; needs `settings.write` and step-up MFA).
- **Permissions:** `api.use` (own keys + calling `/v1`), `api.docs.read`, `api.keys.read`, `api.keys.write`. The built-in `api-user` role holds the first two. `api.use` is re-checked on every request, so removing it stops that user's keys at once.
- **Keys** (`/api/api-keys`): create (shown once, stored hashed), rename/restrict to models, delete; administrators can list and revoke all keys under `/api/admin/api-keys`.
- **Docs:** written as OpenAPI (`server/openapi/openapi.yaml`) and built with Redocly: `npm run docs:lint -w server`, `npm run docs:build -w server` (also part of `npm run build`). People with `api.docs.read` see them at `/api/docs`.

## Quick start

Requires Node.js 22+.

```sh
npm install
cp .env.example .env   # set BASE_URL, ENCRYPTION_KEY, SUPERADMIN_PASSWORD
npm run dev            # development
npm run build && npm start   # production
```

If `SUPERADMIN_PASSWORD` is unset, a random admin password is printed once on first start. See [.env.example](.env.example) for all options, including HTTPS and reverse-proxy settings.

## Updating

Releases are git tags named `vMAJOR.MINOR.PATCH` (semantic versioning), and the `version` in the root `package.json` matches the tag. Updates come from the public repository; set `UPDATE_REPO_URL` to use another one.

```sh
npm run update -w server                 # install the newest release (fetch, install, build; rolls back on failure)
npm run update -w server -- check        # report the installed and newest versions
npm run update -w server -- apply 1.2.0  # install a specific newer release
```

The same flow is available to administrators over `GET /api/admin/update`, `POST /api/admin/update/check` and `POST /api/admin/update/apply` (step-up MFA required). An update needs a git checkout with no local changes to tracked files. Restart the server afterwards; the running process keeps the code it started with.

## Development

```sh
npm test
```

The repo is an npm workspace: [server/](server/) (Express, SQLite) and [web/](web/) (Vite).
