import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { honchoClientOptions, sessionName, type Config } from "./config.ts";
import type { Turn } from "./transcript/codex.ts";

interface Identity {
  thread: string;
  peer: string;
  human: string;
  session: string;
}

export function identityScope(config: Config): string {
  // Scope by endpoint AND workspace, without storing credentials or endpoint
  // URLs in the record. Directory/session-name similarity is not identity.
  const scope = JSON.stringify([honchoClientOptions(config).baseURL, config.workspace]);
  return createHash("sha256").update(scope).digest("hex");
}

function identityPath(config: Config, thread: string): string {
  const key = createHash("sha256").update(thread).digest("hex");
  return join(process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho"), "codex", "sessions", identityScope(config), `${key}.json`);
}

function readIdentity(path: string): Identity | undefined {
  try {
    if (existsSync(`${path}.conflict`)) return undefined;
    const record = JSON.parse(readFileSync(path, "utf8"));
    if ([record.thread, record.peer, record.human, record.session].every((v) => typeof v === "string" && v.length > 0)) return record;
  } catch {
    // Missing, conflicting or damaged identity evidence stays unknown.
  }
}

// Record only an identity actually observed by a hook in its own session.
// Never infer a peer from another chat's text, cwd, UUID, or current OS user.
export function recordSessionIdentity(config: Config, cwd: string, threadId?: string): void {
  if (!threadId || config.aiPeer === config.peerName) return;
  const thread = threadId.toLowerCase();
  const path = identityPath(config, thread);
  const record: Identity = { thread, peer: config.aiPeer, human: config.peerName, session: sessionName(config, cwd, threadId) };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readIdentity(path);
    if (existing && (existing.peer !== record.peer || existing.human !== record.human || existing.session !== record.session)) {
      // A changed configuration makes historical attribution ambiguous. Keep
      // the original evidence and mark the mapping unusable, including on retry.
      writeFileSync(`${path}.conflict`, "conflicting session identity\n", { mode: 0o600 });
    }
  }
}

export function attributeDelegation(turn: Turn, config: Config): Turn {
  const delegation = turn.delegation;
  if (turn.role !== "delegation" || !delegation?.sourceThreadId || delegation.wrapper !== "valid") return turn;
  const thread = delegation.sourceThreadId.toLowerCase();
  const identity = readIdentity(identityPath(config, thread));
  if (!identity || identity.thread !== thread || identity.peer === identity.human || identity.peer === config.peerName) return turn;
  return { ...turn, delegation: { ...delegation, sender: { peer: identity.peer, session: identity.session, scope: identityScope(config) } } };
}

export function unknownDelegationPeer(config: Config): string {
  let peer = "codex-delegation-unknown";
  while (peer === config.peerName || peer === config.aiPeer) peer += "-unknown";
  return peer;
}
