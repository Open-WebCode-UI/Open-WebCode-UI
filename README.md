# Open WebCode UI

A self-hosted AI platform: a powerful, provider-agnostic interface for AI with a chat mode, and the definitive agentic coding platform. Extensible, feature-rich, user-friendly, and built to run entirely offline.

## Highlights

- **Chat mode**: a conversational interface for any model.
- **Agentic coding**: an agent works in per-project workspaces with a terminal, git, checkpoints, skills, and memory.
- **Offline-first**: run fully air-gapped with local models, or connect to cloud providers when you want to.
- **Self-hosted**: your data stays in your `DATA_DIR` (SQLite, workspaces, checkpoints). Stored secrets are encrypted.
- **Multi-user**: SAML single sign-on, WebAuthn passkeys, TOTP, and a break-glass admin account.

## Providers and protocols

Use local and cloud models interchangeably, side by side.

| Kind | Integrations |
| --- | --- |
| Local | Ollama, LM Studio, any OpenAI-compatible server (vLLM, llama.cpp, etc.) |
| Cloud | OpenAI, Anthropic, Google Gemini, Vertex AI, Mistral, Azure OpenAI, Amazon Bedrock |
| Protocols | OpenAI-compatible API, native provider APIs, MCP (Streamable HTTP) |

**MCP** servers extend the agent with external tools. Remote servers over HTTPS are supported.

## Quick start

Requires Node.js 22+.

```sh
npm install
cp .env.example .env   # set BASE_URL, ENCRYPTION_KEY, BREAKGLASS_PASSWORD
npm run dev            # development
npm run build && npm start   # production
```

If `BREAKGLASS_PASSWORD` is unset, a random admin password is printed once on first start. See [.env.example](.env.example) for all options, including HTTPS and reverse-proxy settings.

## Development

```sh
npm test
```

The repo is an npm workspace: [server/](server/) (Express, SQLite) and [web/](web/) (Vite).
