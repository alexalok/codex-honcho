import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RolloutItem, Turn } from "./transcript/codex.ts";

// Codex fires Stop every turn with no final SessionEnd, so writeback runs
// repeatedly over a growing rollout. The cursor records how many turns we've
// already shipped for a session, so each Stop uploads only the new tail.

function cursorDir(): string {
  return join(process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho"), "codex", "cursors");
}

function cursorPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(cursorDir(), `${safe}.json`);
}

export function readCursor(sessionId: string): number {
  return readCaptureCursor(sessionId).count;
}

export interface CaptureCursor {
  count: number;
  format?: "rollout-items-v2";
}

export function readCaptureCursor(sessionId: string): CaptureCursor {
  try {
    const { count, format } = JSON.parse(readFileSync(cursorPath(sessionId), "utf-8"));
    return {
      count: Number.isSafeInteger(count) && count >= 0 ? count : 0,
      ...(format === "rollout-items-v2" ? { format } : {}),
    };
  } catch {
    return { count: 0 };
  }
}

export function writeCursor(sessionId: string, count: number, format?: CaptureCursor["format"]): void {
  mkdirSync(cursorDir(), { recursive: true });
  writeFileSync(cursorPath(sessionId), JSON.stringify({ count, format, at: new Date().toISOString() }));
}

export function selectNewItems(items: RolloutItem[], cursor: CaptureCursor): Delta {
  let start = 0;
  if (cursor.format === "rollout-items-v2") {
    start = cursor.count <= items.length ? cursor.count : 0;
  } else if (cursor.count > 0) {
    // Locate the last message counted by the old parser. Earlier newly
    // recognized tool deliveries are deliberately not historical backfill.
    let legacy = 0;
    const last = items.findIndex((item) => item.legacy && ++legacy === cursor.count);
    start = last < 0 ? 0 : last + 1;
  }
  return { fresh: items.slice(start).flatMap((item) => item.turns), nextCursor: items.length };
}

export interface Delta {
  fresh: Turn[];
  nextCursor: number;
}

// Pure: pick the turns not yet uploaded. A shrunken transcript (cursor past
// the end, e.g. a cleared session) resets to the full set.
export function selectNewTurns(turns: Turn[], cursor: number): Delta {
  const start = cursor <= turns.length ? cursor : 0;
  return { fresh: turns.slice(start), nextCursor: turns.length };
}
