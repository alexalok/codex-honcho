import { recallContext } from "./recall-context.ts";
import { Honcho } from "@honcho-ai/sdk";
import { honchoClientOptions, type Config } from "./config.ts";

async function sessionAndPeers(config: Config, name: string) {
  const honcho = new Honcho(honchoClientOptions(config));
  const [session, userPeer, aiPeer] = await Promise.all([
    honcho.session(name),
    honcho.peer(config.peerName),
    honcho.peer(config.aiPeer),
  ]);
  const delegationPeer = (id: string, unknown: boolean) => honcho.peer(id,
    unknown ? { configuration: { observeMe: false } } : undefined);
  return { session, userPeer, aiPeer, delegationPeer };
}

// Deliberate session creation — run once at SessionStart. addPeers materializes
// the session server-side and associates both peers (unified observation: the
// user models themselves). The write path doesn't repeat this.
export async function createSession(config: Config, name: string) {
  const handles = await sessionAndPeers(config, name);
  await handles.session.addPeers([handles.userPeer, handles.aiPeer]);
  return handles;
}

// Write path: get handles without re-adding peers. The session was created at
// SessionStart; messages from these peers associate with it on addMessages.
export async function getSession(config: Config, name: string) {
  return sessionAndPeers(config, name);
}

// Query only task-matching self-conclusions. Never request a peer card or a
// generic representation, even when search returns no matches.
export async function retrieveTaskMemory(config: Config, query: string, scope?: string): Promise<string[]> {
  if (scope) return (await recallContext(config, scope, query)).representation?.split("\n") ?? [];
  const honcho = new Honcho({ ...honchoClientOptions(config), timeout: 4000, maxRetries: 0 });
  const peer = await honcho.peer(config.peerName);
  const results = await peer.conclusions.query(query, 6, 0.5);
  return results.map((result) => result.content);
}

export const MAX_MEMORY_CHARS = 2400;

export function normalizeFact(value: string): string {
  return value.normalize("NFKC").replace(/^\s*[-*]\s*/, "").replace(/\s+/g, " ").trim();
}

// Treat memory as quoted historical data, not fresh instructions. Deduplicate
// normalized facts before applying a strict budget including the wrapper.
export function renderTaskMemory(facts: string[]): string {
  const open = '<honcho-memory>\nTask-matching historical notes; current instructions take precedence.\n';
  const close = '\n</honcho-memory>';
  const lines: string[] = [];
  const seen = new Set<string>();
  let length = open.length + close.length;
  for (const value of facts) {
    if (typeof value !== "string") continue;
    const fact = normalizeFact(value);
    const key = fact.toLowerCase().replace(/[.!?]+$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const escaped = fact.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const line = `- ${escaped}`;
    if (length + line.length + 1 > MAX_MEMORY_CHARS) continue;
    lines.push(line);
    length += line.length + 1;
    if (lines.length === 6) break;
  }
  return lines.length ? `${open}${lines.join("\n")}${close}` : "";
}
