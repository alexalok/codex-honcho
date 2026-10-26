import { loadConfig, memoryKey, type Config } from "../config.ts";
import { readRolloutItems } from "../transcript/codex.ts";
import { readCaptureCursor, writeCursor, selectNewItems } from "../cursor.ts";
import { enqueue } from "../queue.ts";
import { flush } from "./flush.ts";
import { attributeDelegation, recordSessionIdentity } from "../session-identity.ts";

interface WritebackInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
}

// Pure-local: pull the rollout turns not yet captured into the queue and
// advance the rollout cursor. No network — returns how many were enqueued.
export function capture(key: string, rolloutPath: string, config?: Config): number {
  const items = readRolloutItems(rolloutPath);
  const cursor = readCaptureCursor(key);
  const { fresh, nextCursor } = selectNewItems(items, cursor);
  enqueue(key, config ? fresh.map((t) => attributeDelegation(t, config)) : fresh);
  if (items.length > 0 && (fresh.length > 0 || cursor.format !== "rollout-items-v2")) {
    writeCursor(key, nextCursor, "rollout-items-v2");
  }
  return fresh.length;
}

// Stop / PreCompact (turn-scoped): capture this turn's new rollout tail into
// the queue, then flush inline. Codex kills detached children when the hook
// returns, so the upload must run in-process. Stop fires after the model has
// already responded, so this brief upload doesn't lag the visible turn — and
// it drains any observations queued during the turn too.
export async function writeback(input: WritebackInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.saveMessages) return "";
  if (!input.transcript_path) return "";

  const cwd = input.cwd || process.cwd();
  recordSessionIdentity(config, cwd, input.session_id);
  capture(memoryKey(config, cwd, input.session_id), input.transcript_path, config);
  await flush({ cwd, session_id: input.session_id });
  return "";
}
