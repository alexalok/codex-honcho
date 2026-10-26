import type { Turn } from "./codex.ts";

export interface Delegation {
  transport: "tool-output" | "user-message";
  wrapper: "valid" | "malformed";
  sourceThreadId?: string;
  // Set only from a locally recorded session identity, never from task text.
  sender?: { peer: string; session: string; scope: string };
}

const MARKER = /<\/?codex_delegation(?=[\s>/]|$)/;
const CLOSE = "</codex_delegation>";
const ENVELOPE = /^<codex_delegation>\s*<source_thread_id>([^<>]*)<\/source_thread_id>\s*<input>([^<>]*)<\/input>\s*<\/codex_delegation>$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The desktop escapes &, < and >. Decode exactly once: &amp;lt; is literal
// &lt;, not a second layer of markup. Reject unsupported/broken entities.
function unescape(value: string): string | undefined {
  if (/&(?!(?:amp|lt|gt);)/.test(value)) return undefined;
  return value.replace(/&(amp|lt|gt);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">" })[entity]!);
}

function delegated(text: string, transport: Delegation["transport"]): Turn {
  const match = ENVELOPE.exec(text);
  const source = match && unescape(match[1]);
  const input = match && unescape(match[2]);
  if (source && UUID.test(source) && typeof input === "string" && input.trim()) {
    return {
      role: "delegation", text: input,
      delegation: { transport, wrapper: "valid", sourceThreadId: source },
    };
  }
  // Retain malformed evidence without attributing it to a human or guessing
  // an identity from a partially parsed source field.
  return { role: "delegation", text, delegation: { transport, wrapper: "malformed" } };
}

function userMarker(text: string): number {
  // Desktop envelopes are standalone text, not inline examples in human
  // prose. Also leave Markdown fenced examples and blockquotes as human text.
  let offset = 0;
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
    } else if (!fence) {
      const marker = MARKER.exec(line);
      if (marker && !line.slice(0, marker.index).trim()) return offset + marker.index;
    }
    offset += line.length + 1;
  }
  return -1;
}

// Mixed compatibility messages can contain human text alongside envelopes.
// Keep the pieces in order and never assign the forwarded section to a human.
// For tool delivery, surrounding text is also agent-origin, with unknown source.
export function splitDelegations(text: string, transport: Delegation["transport"]): Turn[] {
  const turns: Turn[] = [];
  const plain = (value: string) => {
    if (!value.trim()) return;
    turns.push(transport === "user-message"
      ? { role: "user", text: value.trim() }
      : delegated(value.trim(), transport));
  };
  let rest = text;
  for (;;) {
    const index = transport === "user-message" ? userMarker(rest) : (MARKER.exec(rest)?.index ?? -1);
    if (index < 0) {
      // Preserve ordinary queued human text byte-for-byte during replay.
      if (turns.length === 0 && transport === "user-message" && rest.trim()) turns.push({ role: "user", text: rest });
      else plain(rest);
      break;
    }
    plain(rest.slice(0, index));
    rest = rest.slice(index);
    const close = rest.indexOf(CLOSE);
    // An incomplete envelope consumes the remaining text conservatively.
    const end = close < 0 ? rest.length : close + CLOSE.length;
    const turn = delegated(rest.slice(0, end).trim(), transport);
    if (turn.delegation?.wrapper === "malformed") {
      turns.push(delegated(rest.trim(), transport));
      break;
    }
    turns.push(turn);
    rest = rest.slice(end);
  }
  return turns;
}

export function hasDelegationMarker(text: string): boolean {
  return MARKER.test(text);
}
