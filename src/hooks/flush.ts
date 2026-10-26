import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { loadConfig, sessionName, memoryKey, type Config } from "../config.ts";
import { getSession } from "../memory.ts";
import { readQueue, sentCount, setSentCount, queueDir, safe, type QueueEntry } from "../queue.ts";
import { hasDelegationMarker, splitDelegations } from "../transcript/delegation.ts";
import { attributeDelegation, identityScope, unknownDelegationPeer } from "../session-identity.ts";

interface FlushInput {
  cwd?: string;
  session_id?: string;
}

// Honcho's per-message content ceiling is ~25k chars; stay just under it.
const MAX_CHARS = 24000;
// Honcho rejects an addMessages call with more than 100 messages, and the SDK
// sends one POST per call without chunking, so we cap each call here.
const BATCH_LIMIT = 100;

type SessionHandles = Awaited<ReturnType<typeof getSession>>;
type PeerMessage = ReturnType<SessionHandles["userPeer"]["message"]>;

// Split an oversized body into <=MAX_CHARS pieces, preferring a newline/space
// boundary, so a long turn is preserved across parts instead of truncated.
// Capped at BATCH_LIMIT parts so one queue entry never exceeds a single upload
// call — a >2.4MB single turn (effectively impossible) drops its overflow tail.
function chunkText(text: string, max = MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  let total = 1;
  let chunks: string[] = [];
  for (;;) {
    const labelBudget = `[part ${total}/${total}] `.length;
    const payloadMax = Math.max(1, max - labelBudget);
    chunks = splitText(text, payloadMax);
    if (chunks.length === total || `[part ${chunks.length}/${chunks.length}] `.length === labelBudget) {
      total = chunks.length;
      break;
    }
    total = chunks.length;
  }
  if (chunks.length > BATCH_LIMIT) chunks = chunks.slice(0, BATCH_LIMIT);
  total = chunks.length;
  return chunks.map((c, i) => `[part ${i + 1}/${total}] ${c}`);
}

function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.25) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.25) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function lockPath(key: string): string {
  return join(queueDir(), `${safe(key)}.lock`);
}

async function messagesForEntry(
  entry: QueueEntry,
  handles: SessionHandles,
  config: Config,
  peers: Map<string, SessionHandles["aiPeer"]>,
): Promise<PeerMessage[]> {
  // Pending queues from older versions can still contain user-role wrappers.
  // Normalize them on replay without rewriting the durable queue/sent marker.
  const parts: QueueEntry[] = entry.role === "user" && hasDelegationMarker(entry.text)
    ? splitDelegations(entry.text, "user-message").map((t) => ({ ...attributeDelegation(t, config), at: entry.at }))
    : [entry];
  const messages: PeerMessage[] = [];
  for (const part of parts) {
    let peer = part.role === "user" ? handles.userPeer : handles.aiPeer;
    let metadata: Record<string, unknown> | undefined;
    if (part.role === "delegation") {
      const provenance = part.delegation;
      const sender = provenance?.wrapper === "valid" && provenance.sourceThreadId &&
        provenance.sender?.scope === identityScope(config) && provenance.sender.peer !== config.peerName
        ? provenance.sender : undefined;
      const id = sender?.peer || unknownDelegationPeer(config);
      if (!peers.has(id)) peers.set(id, await handles.delegationPeer(id, !sender));
      peer = peers.get(id)!;
      metadata = {
        type: "delegation", origin: "agent", provenance_scope: "routing",
        transport: provenance?.transport ?? "unknown",
        wrapper: provenance?.wrapper ?? "malformed",
        source_thread_id: provenance?.sourceThreadId ?? null,
        sender_resolution: sender ? "local-session" : "unknown",
        source_peer: sender?.peer ?? null,
        source_session: sender?.session ?? null,
      };
    } else if (part.role === "tool") {
      metadata = { type: "tool" };
    }
    const body = part.role === "tool" ? `[tool] ${part.text}` : part.text;
    messages.push(...chunkText(body).map((piece) => peer.message(piece, {
      createdAt: part.at, ...(metadata ? { metadata } : {}),
    })));
  }
  // Keep the existing per-entry ceiling, including entries split into mixed
  // human/delegation pieces, so sent markers still move at entry boundaries.
  return messages.slice(0, BATCH_LIMIT);
}

// Single-flusher lock: skip if another flush holds it (dead owners are taken
// over). Prevents two concurrent flushes from double-sending the same entries.
function acquireLock(key: string): boolean {
  const path = lockPath(key);
  try {
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      const owner = parseInt(readFileSync(path, "utf-8").trim(), 10);
      process.kill(owner, 0); // throws if the owner is gone
      return false;
    } catch {
      try {
        writeFileSync(path, String(process.pid));
        return true;
      } catch {
        return false;
      }
    }
  }
}

function releaseLock(key: string): void {
  try {
    unlinkSync(lockPath(key));
  } catch {
    // already gone
  }
}

// Background worker: drain pending queue entries to Honcho, in order, and
// advance the sent marker only on success so failures retry next time.
export async function flush(input: FlushInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.saveMessages) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd, input.session_id);
  const key = memoryKey(config, cwd, input.session_id);

  if (!acquireLock(key)) return "";
  try {
    const all = readQueue(key);
    const start = sentCount(key);
    if (all.length - start <= 0) return "";

    const handles = await getSession(config, name);
    const { session } = handles;
    const peers = new Map<string, SessionHandles["aiPeer"]>();
    let batch: PeerMessage[] = [];

    // Drain pending entries in order, flushing only at entry boundaries so the
    // sent marker always lands on a fully-uploaded entry — a failure mid-drain
    // just retries from the last completed entry, no sub-entry bookkeeping. The
    // batch is flushed right before an entry would push it past BATCH_LIMIT, and
    // once more at the end, so no single call exceeds Honcho's per-request limit.
    for (let i = start; i < all.length; i++) {
      const messages = await messagesForEntry(all[i], handles, config, peers);
      if (batch.length > 0 && batch.length + messages.length > BATCH_LIMIT) {
        await session.addMessages(batch);
        setSentCount(key, i);
        batch = [];
      }
      batch.push(...messages);
    }
    if (batch.length > 0) {
      await session.addMessages(batch);
      setSentCount(key, all.length);
    }
  } finally {
    releaseLock(key);
  }
  return "";
}
