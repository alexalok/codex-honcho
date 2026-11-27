# codex-honcho

[![codex-honcho](./assets/honcho_codex.png)](https://honcho.dev)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/@honcho-ai/codex-honcho?color=blue)](https://www.npmjs.com/package/@honcho-ai/codex-honcho)
[![Honcho](https://img.shields.io/badge/Honcho-Memory%20API-blue)](https://honcho.dev)

**Persistent memory for [OpenAI Codex](https://developers.openai.com/codex), powered by [Honcho](https://honcho.dev) from Plastic Labs.**

Give Codex long-term memory that survives context resets, session restarts, and fresh conversations. Codex remembers what you're working on, your preferences, and the decisions you've made — across every project. Lifecycle hooks capture each session to Honcho and inject the relevant context back at session start, so you never have to repeat yourself.

## What You Get

- **Persistent Memory** — Codex remembers your preferences, projects, and context across sessions
- **Survives Context Resets** — Memory persists through `/clear`, compaction, and restarts
- **Active Recall** — Codex can search your history and query what Honcho knows about you mid-task, not just at startup
- **Git Awareness** — Optionally scope memory per branch, so feature work keeps its own context
- **Flexible Sessions** — Map memory per directory, per git branch, or per chat instance
- **Local-First Capture** — Conversations are queued to disk instantly and uploaded in the background — capture never blocks your turn or hits the network mid-conversation
- **Cross-Tool Context** — Shares `~/.honcho/config.json` with other Honcho integrations (Claude Code, Cursor, …), so context can follow you between tools

## Prerequisites

- **[Codex](https://developers.openai.com/codex) ≥ 0.136.0**
- **[Node](https://nodejs.org)** on your `PATH` (runs the installer and the hooks)

## Quick Start

### Step 1: Get Your Honcho API Key

1. Go to **[app.honcho.dev](https://app.honcho.dev)**
2. Sign up or log in
3. Copy your API key (starts with `hch-`)

### Step 2: Save Your API Key

Your key lives in **`~/.honcho/config.json`** — the single config file every Honcho integration reads. codex-honcho takes the key straight from there.

**Already have your key in `~/.honcho/config.json`?** If another Honcho integration already wrote it there, there's nothing to do — skip to Step 3 and `install` picks it up automatically. (codex-honcho reads only this file, `hosts.codex`, and `HONCHO_API_KEY` — not any tool's private config, so confirm the key is in `~/.honcho/config.json` with `codex-honcho status`.)

**First time?** Create it with the Honcho CLI:

```bash
honcho init   # prompts for your key, writes ~/.honcho/config.json
              # no CLI yet? uv tool install honcho-cli && honcho init
```

Either way the key stays in one place. If you'd rather write the file yourself:

```jsonc
// ~/.honcho/config.json
{ "apiKey": "hch-your-api-key-here" }
```

### Step 3: Install the Plugin

```bash
npm install -g @honcho-ai/codex-honcho
codex-honcho install      # registers hooks + MCP + skill in ~/.codex
```

`install` copies your resolved key into `~/.codex/config.toml` so the Honcho MCP server authenticates with no environment variable to set. If you ever rotate your key, re-run `codex-honcho install` to refresh it.

### Step 4: Restart Codex

Restart Codex (or start a new session) to load the hooks and the `[features].hooks` flag. On your next session start you'll see Honcho memory load into context.

### Step 5: (Optional) Tell Codex to use its memory

The bundled `honcho-memory` skill already nudges Codex to recall and save actively. To reinforce it, add a short directive to your global Codex instructions (`~/.codex/AGENTS.md`):

```markdown
# Honcho Memory

You have persistent memory via Honcho. Context about me is loaded at the start
of every session — trust it and act on it; don't ask me what you already know.
Use the Honcho MCP tools (`search`, `chat`) to recall more mid-task, and
`create_conclusions` to save new preferences, decisions, and patterns as you learn them.
```

## MCP Tools

Once installed, Codex can call these Honcho tools directly:

| Tool                  | Description                                          |
| --------------------- | --------------------------------------------------- |
| `search`              | Semantic search across your session messages        |
| `chat`                | Ask Honcho a natural-language question about you     |
| `get_peer_context`    | Fetch the current model of you (representation + peer card) |
| `get_representation`  | Lightweight representation string                   |
| `create_conclusions`  | Save durable insights to memory                      |
| `list_conclusions`    | List saved conclusions                              |
| `query_conclusions`   | Semantic search across derived conclusions          |
| `delete_conclusion`   | Remove a conclusion by ID                           |

## Commands

| Command                  | Effect                                            |
| ------------------------ | ------------------------------------------------- |
| `codex-honcho install`   | Install hooks + MCP + skill                        |
| `codex-honcho status`    | Installed components, pending queue depth, GUI link |
| `codex-honcho remove`    | Strip only what this installs                       |

## Configuration

All settings live in `~/.honcho/config.json` (shared with other Honcho integrations). Codex-specific settings go under `hosts.codex`, falling back to the root fields. The hooks only ever read this file; `install` is the only writer.

```jsonc
{
  "apiKey": "hch-…",
  "peerName": "alice",              // your identity (default: $USER)
  "hosts": {
    "codex": {
      "workspace": "codex",          // Honcho workspace for Codex memory
      "sessionStrategy": "per-directory",
      "injectPerPrompt": false,      // repeat recall after initial prompt (opt-in)
      "saveMessages": true           // false = read memory but never write
    }
  }
}
```

### Session Strategies

Controls how Codex conversations map to Honcho sessions:

| Strategy | Session name | Best for |
| --- | --- | --- |
| `per-directory` (default) | `my-app` | Most users — each project accumulates its own memory |
| `git-branch` | `my-app-main` | Feature-branch workflows where context per branch matters |
| `chat-instance` | `019ea7df-805e-76d1-af52-0123456789ab` | One session per conversation; peer memory remains available across chats |

An explicit `sessions[cwd]` mapping overrides all strategies. Environment overrides: `HONCHO_API_KEY`, `HONCHO_PEER_NAME`, `HONCHO_CONFIG_DIR`.

### Cross-chat delegation

Incoming desktop `send_message_to_thread` tasks are captured from the `codex_app` tool output or its compatibility user-message wrapper. They are recorded as agent-origin messages, even when the transport uses `role=user`. Source thread IDs, transport and attribution evidence are stored as structured message metadata and retained on every chunk.

Session hooks record the configured AI peer and Honcho session name in a local identity index under `~/.honcho/codex/sessions/` (or `HONCHO_CONFIG_DIR`). An exact source-thread match in the same endpoint and workspace can identify the sending peer. Missing, conflicting or unavailable mappings use the explicit `codex-delegation-unknown` peer with observation disabled. Another account's private index is not searched. A source thread ID is routing provenance; it authenticates neither the sender nor permission to act.

Existing cursors migrate without replaying already captured messages. Historical tool deliveries before the old cursor boundary are not backfilled, and already uploaded records are not corrected. Pending compatibility wrappers are reclassified when flushed. See [delegation capture details](docs/delegation.md) for supported shapes, fixture verification and upgrade considerations.

## How It Works

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Codex                                    │
├──────────────────────────────────────────────────────────────────────┤
│  SessionStart  │  UserPrompt     │  PostToolUse   │  Stop / PreCompact │
│  ───────────   │  ───────────    │  ────────────  │  ───────────────── │
│  recall:       │  prompt:        │  observe:      │  writeback:        │
│  tools + link  │  task search    │  note tool     │  capture the new   │
│  no profile    │  bounded notes  │  calls         │  transcript tail   │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
          ~/.honcho/codex/queue/<key>.jsonl   (append-only, local, instant)
                              │
                              ▼  flush (inline, end of turn)
                         Honcho API  →  Persistent Memory
                              │
                              ▼  retrieved after the next non-trivial user prompt
```

The plugin hooks into Codex's lifecycle events:

- **SessionStart** (`recall`) — creates/materializes the session and exposes a compact MCP tool hint plus session link. It never retrieves or injects a peer profile, peer card, or generic representation.
- **UserPromptSubmit** (`prompt`) — always searches self-conclusions after the first eligible user prompt. `injectPerPrompt` defaults to `false` and controls only subsequent prompts; `true` enables repeated recall. It skips empty, trivial, and recognized generated prompts; requests at most 13 matches within cosine distance 0.5; bounds the query to 2,000 characters and the rendered block to 2,400 characters; and deduplicates normalized facts and consecutive identical blocks. Oversized individual facts are skipped. No matches or API failures produce no memory block, with no generic fallback. Peer identity remains necessary for API/storage use but is not rendered as a profile.
- **PostToolUse** (`observe`) — appends a one-line note for significant tool calls to the local queue
- **Stop / PreCompact** (`writeback`) — captures the new transcript tail, then flushes the queue to Honcho

Task recall uses a separate digest cache, never the old profile cache. Session start/resume/clear/compact resets initial-recall state and duplicate suppression so relevant notes can return after a context reset. A successful search, including an empty result, completes initial recall; API failures leave it pending for the next eligible prompt. Recall requests have a 4-second timeout per SDK request and no retries; MCP tools remain available for deeper recall. Semantic relevance depends on Honcho’s search results; this does not purge old contaminated server memories.

Capture is **local-first**: hooks only ever append to a plain JSONL queue, so they're instant and never touch the network. The flush is lock-guarded and advances a per-chunk sent marker, so a failed or partial upload simply stays queued and retries on the next turn. Inspect the local queue any time with `tail -f ~/.honcho/codex/queue/*.jsonl`, and run `codex-honcho status` to see the pending depth plus a deep link to your session in the Honcho GUI to confirm what landed server-side.

## Troubleshooting

**No memory loading / MCP not registered.** Confirm your key is in `~/.honcho/config.json` (`codex-honcho status` shows `honcho config: found`). If it's missing, run `honcho init` (or add `{ "apiKey": "hch-…" }` to the file yourself), then re-run `codex-honcho install` — without a key, install registers the hooks and skill but skips the MCP server.

**Hooks aren't firing.** Restart Codex after installing so it loads `hooks.json` and the `[features].hooks` flag. Check `codex-honcho status` for installed components and pending queue depth.

**Memory not persisting.** Make sure `saveMessages` isn't set to `false` under `hosts.codex`.

## What Install Writes

| Path | Change |
|---|---|
| `~/.codex/honcho/` | staged copy of the bundle the hooks run (kept stable across npm/npx cache eviction) |
| `~/.codex/hooks.json` | adds the four hook entries (merged; your own hooks untouched) |
| `~/.codex/config.toml` | sets `[features].hooks = true`; registers `[mcp_servers.honcho]` → `mcp.honcho.dev` (native HTTP) |
| `~/.codex/skills/honcho-memory/` | the active-recall skill |
| `~/.honcho/config.json` | persists the resolved `apiKey` + `peerName` (other fields and `hosts.*` blocks preserved) |

`codex-honcho remove` reverses exactly these.

## Install from a GitHub Clone (no npm)

```bash
git clone https://github.com/plastic-labs/codex-honcho
cd codex-honcho
./install.sh              # bun install + bun run bin/codex-honcho.ts install
```

The clone path runs the TypeScript source directly and so requires **[bun](https://bun.sh)**; it wires the hooks to `bun run <this dir>/bin/codex-honcho.ts`, so keep the clone in place. The npm install instead stages the bundled `dist/codex-honcho.mjs` to `~/.codex/honcho/` and wires hooks to `node` — node-only, and stable across `npm update`, npx cache eviction, or removing the package.

## Development

```
bin/codex-honcho.ts      CLI: install · remove · status · <hook verb>
src/dispatch.ts          verb → handler routing
src/hooks/               recall · prompt · observe · writeback · flush
src/transcript/codex.ts  Codex rollout (.jsonl) parser
src/queue.ts             append-only outbox + sent high-water-mark
src/cursor.ts            per-conversation rollout delta cursor
src/connectors/          hooks.json · config.toml MCP block · skill writers
src/config.ts            hosts.codex resolution; session naming
skills/honcho-memory/    when-to-recall guidance for the model
```

```bash
bun test
bun run typecheck
```

## License

MIT — see [LICENSE](LICENSE)

## Links

- **Honcho**: [honcho.dev](https://honcho.dev) — the memory API
- **Documentation**: [docs.honcho.dev](https://docs.honcho.dev)
- **Discord**: [Join the community](https://discord.gg/plasticlabs)
- **X**: [@honchodotdev](https://x.com/honchodotdev)
- **Plastic Labs**: [plasticlabs.ai](https://plasticlabs.ai)

### Desktop project scopes

Set `hosts.codex.sessionStrategy` to `"chat-instance"` and
`hosts.codex.scopeStrategy` to `"desktop-project"` in `~/.honcho/config.json`.
The default scope strategy remains `"none"` for CLI compatibility. Explicit
`sessions` overrides are incompatible with desktop scopes: shared sessions cannot
safely belong to independently moved chats.

Chat-instance session names now use the full, unchanged Codex chat ID, independent
of cwd. Existing short-ID/directory sessions are not renamed or backfilled.
Already-sent messages stay in their original sessions; new messages use the full ID.

The desktop adapter reuses the framed JSON-RPC transport from
[jev-skill-router PR #4](https://github.com/alexalok/jev-skill-router/pull/4).
It calls only `list_threads` and `list_projects`: recent/pinned entries first,
then paginated active/archived history. Matching includes host identity. No private
app DB, global state file, directory-name inference, or Git fallback is used.
A lookup is bounded to eight seconds and 100 pages per history category.

Scopes use `codex-project-<sha256([hostId,projectId])>`; creation metadata stores
project ID, name and host. Names can change without changing scope identity.
Worktree chats follow their desktop project assignment. Explicit `projectId: null`
means projectless: no managed scope and normal global peer recall. Missing chats,
missing fields, unavailable pipe or malformed responses mean unknown: suppress
startup recall and retain queued messages for a later retry. Unknown never means
projectless. CLI usage should leave desktop scopes disabled.

SessionStart and writeback reconcile managed membership; moving a chat removes its
old managed scope membership before adding the new one. Moving to projectless
removes managed memberships. Server reconciliation/backfill is asynchronous, and
moves affect the whole chat's history. Unrelated, externally managed memberships
are not removed. Membership journals are isolated by Honcho endpoint/workspace. Concurrent hooks
serialize membership changes. A process killed during the tiny stale-lock recovery
section can leave a `.lock.recovery` guard; inspect its owner before manually
removing it. Queued messages remain pending while reconciliation is blocked.

Automatic project recall starts on the first eligible prompt, using the task query
against the scope's representation with frequent-fact fallback disabled, at most
six matches and maximum search distance 0.5. Results use the same bounded, escaped
historical-fact renderer as unscoped task recall. SessionStart never loads a generic
representation or global peer card. Context cache checks the scope boundary on resume and each prompt, including when
per-prompt injection is disabled. Project moves refresh the scope hint. MCP tools are
still workspace-wide: the hook supplies the scope ID and tells the agent to pass
it for project queries; intentional cross-project queries may omit it. This is
recall organization, not an API-key authorization boundary.

The desktop pipe is internal and can change. On macOS hooks must use
`exec "${CODEX_MCP_NODE_PATH:-node}" ...` so the signed runtime connects directly
under the hook host. Shell invocation alone does not prove hook access. Existing
hook registrations need updating and may require Codex's normal hook trust approval.
Do not run the installer merely to update hooks if your MCP configuration is custom.
