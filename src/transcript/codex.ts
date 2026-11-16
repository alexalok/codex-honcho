import { readFileSync } from "node:fs";
import { hasDelegationMarker, splitDelegations, type Delegation } from "./delegation.ts";

// Codex writes each session to a "rollout" JSONL file under
// ~/.codex/sessions/<id>/<id>.jsonl (archived copies live flat under
// ~/.codex/archived_sessions/). Every line is a { type, payload } event.
// Conversation turns are `response_item` events whose payload is a message;
// user text arrives in input_text blocks, assistant text in output_text.

export type Role = "user" | "assistant" | "delegation";

export interface Turn {
  role: Role;
  text: string;
  at?: string;
  delegation?: Delegation;
}

export interface RolloutItem {
  turns: Turn[];
  // Whether the pre-delegation parser counted this item. Used to migrate its
  // count cursor without shifting positions or replaying already sent turns.
  legacy: boolean;
}

interface RolloutEvent {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
    internal_chat_message_metadata_passthrough?: {
      content_item_kinds?: unknown;
      content_item_metadata?: unknown;
    };
    output?: unknown;
    name?: string;
    namespace?: string;
    call_id?: string | null;
    cwd?: string;
    id?: string;
  };
}

const TEXT_BLOCK_TYPES = new Set(["input_text", "output_text", "text"]);

// Codex injects its own context as user-role messages (environment, instruction
// blobs, abort markers). These aren't things the user said, so they're dropped
// from what we persist to Honcho.
const CODEX_SYSTEM_TAGS = [
  "environment_context",
  "turn_aborted",
  "user_instructions",
  "apps_instructions",
  "plugins_instructions",
  "skills_instructions",
  "collaboration_mode",
];

function isInjectedSystemTurn(text: string): boolean {
  const t = text.trimStart();
  return CODEX_SYSTEM_TAGS.some((tag) => t.startsWith(`<${tag}>`) || t.startsWith(`<${tag} `));
}

// Older rollouts lack provenance. Require the complete generated envelope,
// not just an AGENTS heading or a mention inside an ordinary user request.
const AGENTS_ENVELOPE = /^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>\s*(?:<environment_context>[\s\S]*<\/environment_context>\s*)?$/;
const ENVIRONMENT_ENVELOPE = /^<environment_context>[\s\S]*<\/environment_context>$/;

function authoredUserText(payload: NonNullable<RolloutEvent["payload"]>): string {
  const content = payload.content;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  const kinds = metadata?.content_item_kinds;
  const provenance = metadata?.content_item_metadata;
  const blocks = Array.isArray(content) ? content : [{ type: "input_text", text: content }];
  let removedAgents = false;
  const retained = blocks.filter((block, index) => {
    if (!block || !TEXT_BLOCK_TYPES.has(block.type) || typeof block.text !== "string") return false;
    const kind = Array.isArray(kinds) ? kinds[index] : undefined;
    const origin = Array.isArray(provenance) ? provenance[index]?.provenance?.type : undefined;
    const hasProvenance = typeof kind === "string" || typeof origin === "string";
    const injected = kind === "agents_md.instructions" || origin === "agents_md"
      || (!hasProvenance && AGENTS_ENVELOPE.test(block.text.trim()));
    if (injected) removedAgents = true;
    return !injected;
  });
  // Desktop bundles environment context with AGENTS in the same response item.
  // Keep any authored blocks beside it, but do not save the companion context.
  return collectText(removedAgents
    ? retained.filter((block) => !ENVIRONMENT_ENVELOPE.test(block.text.trim()))
    : retained);
}

function collectText(content: unknown, types = TEXT_BLOCK_TYPES): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && types.has(b.type) && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

function* events(path: string): Generator<RolloutEvent> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === "object") yield event as RolloutEvent;
    } catch {
      // Skip malformed lines rather than failing the whole read.
    }
  }
}

// Read the full conversation, in order, dropping tool/reasoning/system noise.
export function readRollout(path: string): Turn[] {
  return readRolloutItems(path).flatMap((item) => item.turns);
}

export function readRolloutItems(path: string): RolloutItem[] {
  const items: RolloutItem[] = [];
  for (const event of events(path)) {
    if (event.type !== "response_item") continue;
    const payload = event.payload;
    if (!payload) continue;
    // turn/start.toolOutput is serialized as an unpaired function_call_output.
    // Only this specific desktop delivery tool is conversational input. Shell,
    // MCP, custom-tool outputs and responses to outgoing calls remain ignored.
    if (payload.type === "function_call_output") {
      if (payload.namespace !== "codex_app" || payload.name !== "send_message_to_thread" || payload.call_id != null) continue;
      const text = collectText(payload.output, new Set(["input_text"]));
      if (!hasDelegationMarker(text)) continue;
      items.push({ legacy: false, turns: splitDelegations(text, "tool-output").map((t) => ({ ...t, at: event.timestamp })) });
      continue;
    }
    if (payload.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;

    const text = collectText(payload.content);
    if (!text) continue;
    if (payload.role === "user" && isInjectedSystemTurn(text)) continue;

    const authored = payload.role === "user" ? authoredUserText(payload) : text;
    // These messages were counted by both earlier parsers. Preserve the slot
    // even when every block was injected, so saved cursors never shift.
    const turns: Turn[] = !authored ? [] : payload.role === "user"
      ? splitDelegations(authored, "user-message")
      : [{ role: "assistant", text }];
    items.push({ legacy: true, turns: turns.map((t) => ({ ...t, at: event.timestamp })) });
  }
  return items;
}

// The session_meta header line carries the working directory Codex launched in.
export function readRolloutCwd(path: string): string | undefined {
  for (const event of events(path)) {
    if (event.type === "session_meta" && typeof event.payload?.cwd === "string") {
      return event.payload.cwd || undefined;
    }
  }
  return undefined;
}
