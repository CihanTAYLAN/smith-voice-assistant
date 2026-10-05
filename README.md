# Smith

A personal voice-first AI assistant: a Rust/Tauri desktop client that talks to Gemini Live (speech-to-speech) and a multi-tenant TypeScript backend that provides memory, tools and background agent runs.

> **Status:** personal project, archived Oct 2026. Built and used over roughly two months (Aug to Oct 2026). The code is published as a portfolio piece and is not maintained. Many in-code comments and the ADRs are written in Turkish.

## Highlights

- **Gemini Live speech-to-speech.** One WebSocket carries microphone audio in and synthesized speech out. Tool calls run on the device and are answered mid-conversation, with an echo gate and a speaker-verification gate so only the owner's voice can write to memory.
- **Rust / Tauri 2 desktop client.** Audio capture and playback, screen perception, system tools (terminal, apps, volume, files), reminders, a mission-control dashboard and a transparent "pet" window (`apps/desktop`).
- **TypeScript / Hono gateway.** A single entry point for HTTP and WebSocket clients: tenant resolution, auth (password, JWT, refresh rotation, device pairing) and tool endpoints (`apps/gateway`).
- **Agent loop and tool registry.** A provider-neutral turn/step loop with a typed tool registry and a monotonic guard against runaway loops (`packages/core`, ADR 0010).
- **pgvector memory.** Semantic memory with per-record sensitivity classes (`public | personal | secret`), scoped search and fail-closed recall; secrets never reach the live model (`packages/memory`).
- **Multi-tenant Postgres with RLS.** Every tenant table carries a `workspaceId`, every query requires a branded `Scope` type and row-level security is on from day one, so an unscoped query does not compile (`packages/tenancy`, `packages/db`).
- **BullMQ worker.** Memory indexing, session summaries and agent runs execute off the request path (`apps/worker`).
- **Engineering gates.** pnpm catalog, supply-chain controls (`minimumReleaseAge`, explicit `allowBuilds`), lefthook pre-commit gates (format, lint, secret scan, ADR numbering), Conventional Commits and 14 architecture decision records in [`docs/decisions`](docs/decisions).

## Architecture

```mermaid
flowchart LR
    subgraph Client["apps/desktop (Rust, Tauri 2 + React)"]
        MIC[Mic, speaker,<br/>screen perception]
        LIVE[Live session +<br/>tool loop]
        SYS[System tools<br/>run on the device]
        MIC <--> LIVE
        LIVE --> SYS
    end

    GEM[(Gemini Live API<br/>speech-to-speech)]
    LIVE <-->|WebSocket audio| GEM

    subgraph Backend["Backend (TypeScript)"]
        GW[apps/gateway<br/>Hono HTTP + WS<br/>tenant scope + RLS]
        Q[[BullMQ queue]]
        WK[apps/worker<br/>memory index, summaries,<br/>agent runs]
        GW --> Q --> WK
    end

    LIVE -->|HTTP tool bridge| GW

    PG[(Postgres 16<br/>pgvector + RLS)]
    RD[(Redis 7)]
    LLM[LLM provider<br/>Gemini or OpenAI-compatible]

    GW --> PG
    WK --> PG
    Q --- RD
    GW --> LLM
    WK --> LLM
```

The core is headless and the protocol is the contract: a new client only has to speak `@smith/protocol`.

## Repository layout

| Path                     | What it is                                                          |
| ------------------------ | ------------------------------------------------------------------- |
| `apps/desktop`           | Tauri 2 + React desktop client: Live voice, system tools, dashboard |
| `apps/gateway`           | Hono HTTP + WebSocket gateway, single entry point                   |
| `apps/worker`            | BullMQ consumer: memory index, session summary, agent runs          |
| `apps/cli`               | Terminal client                                                     |
| `packages/protocol`      | Wire contract shared by every client                                |
| `packages/tenancy`       | Workspace `Scope` primitive; unscoped queries cannot be written     |
| `packages/db`            | Prisma 7 + pgvector + RLS migrations                                |
| `packages/env`           | Zod-validated, fail-fast configuration                              |
| `packages/auth`          | Passwords, access/refresh tokens, device pairing codes              |
| `packages/llm`           | Role-based model routing (Anthropic and OpenAI-compatible)          |
| `packages/memory`        | pgvector embeddings, scoped upsert/search, recall                   |
| `packages/core`          | Agent tool loop, tool registry, monotonic guard                     |
| `packages/mission`       | Mission control: team registry and task-board state machine         |
| `packages/queue`         | BullMQ queue contract: name registry, job presets, scoped payloads  |
| `packages/sandbox`       | Tool-execution isolation policy and egress rules (design stage)     |
| `packages/observability` | Langfuse/OTel tracing, honest no-op when unconfigured               |
| `docs/decisions`         | Architecture decision records                                       |

## Getting started

Requirements: Node.js 22+, pnpm 11.9, Docker (Postgres with pgvector, Redis). Building the desktop client also needs a Rust toolchain and the Tauri 2 prerequisites.

```bash
pnpm install                                    # also installs git hooks (lefthook)
docker compose -f docker/dev-compose.yml up -d  # Postgres (pgvector) on 5433, Redis on 6380
cp .env.example .env                            # then edit, see below
pnpm db:deploy                                  # apply migrations
pnpm verify                                     # format, lint, typecheck, test, build
```

Minimal `.env` values (see `.env.example` for the full list). The database credentials below are the local development defaults from the compose file:

```bash
DATABASE_URL=postgresql://smith:smith@127.0.0.1:5433/smith
REDIS_URL=redis://127.0.0.1:6380
SESSION_SECRET=replace-with-at-least-32-random-characters

# Optional remote chat model (default is a local Ollama endpoint)
SMITH_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
SMITH_LLM_API_KEY=<your-gemini-api-key>
SMITH_LLM_MODEL=<gemini-model-name>

# Desktop Live voice session
SMITH_GEMINI_KEY=<your-gemini-api-key>
```

Run the services and the desktop client:

```bash
pnpm build
pnpm --filter @smith/gateway start
pnpm --filter @smith/worker start
pnpm --filter @smith/desktop tauri:dev
```

The helper scripts in `scripts/` (`dev-win.ps1`, `smith-up.ps1`, ...) automate a similar flow on Windows.

## Documentation

- [`AGENTS.md`](AGENTS.md): working contract for humans and coding agents (red lines, conventions, package map)
- [`docs/decisions`](docs/decisions): architecture decision records, from audio perception to agent engines

## Author

Cihan Taylan, [linkedin.com/in/cihantaylan](https://linkedin.com/in/cihantaylan)

## License

[MIT](LICENSE)
