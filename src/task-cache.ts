import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import type { Config } from "./config.ts";

// Separate namespace: legacy profile caches are never consumed. Only a digest
// of the last task result is stored, scoped to endpoint, workspace and peer.
function path(config: Config, key: string): string {
  const identity = JSON.stringify([config.endpoint, config.workspace, config.peerName, key]);
  return join(process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho"), "codex", "task-recall",
    `${digest(identity)}.txt`);
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function resetTaskInjection(config: Config, key: string): void {
  try { rmSync(path(config, key), { force: true }); } catch { /* Best effort. */ }
}
export function taskAlreadyInjected(config: Config, key: string, block: string): boolean {
  try { return readFileSync(path(config, key), "utf8") === digest(block); } catch { return false; }
}
export function markTaskInjected(config: Config, key: string, block: string): void {
  try {
    const file = path(config, key);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, digest(block), { mode: 0o600 });
  } catch { /* Cache failure must not discard useful recall. */ }
}
