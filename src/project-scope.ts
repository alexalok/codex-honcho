import { Honcho } from "@honcho-ai/sdk";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { honchoClientOptions, type Config } from "./config.ts";
import { identityScope } from "./session-identity.ts";
import { resolveChatProject, type ProjectResult } from "./app-projects.ts";

export function projectScopeId(project: Extract<ProjectResult, { status: "project" }>): string {
  // Name is mutable and non-unique; identity must survive project renames.
  return `codex-project-${createHash("sha256").update(JSON.stringify([project.hostId, project.id])).digest("hex")}`;
}

export async function resolveScope(config: Config, chatId?: string): Promise<ProjectResult | { status: "disabled" }> {
  if (config.scopeStrategy !== "desktop-project") return { status: "disabled" };
  if (config.sessionStrategy !== "chat-instance" || !chatId || (config.sessions && Object.keys(config.sessions).length > 0)) {
    return { status: "unknown", reason: "desktop-project scopes require chat-instance and no session overrides" };
  }
  return resolveChatProject(chatId);
}

// Only memberships managed by this integration are removed. Journal before adding
// so interrupted writes can be reconciled on the next hook without losing ownership.
export async function syncProjectScope(config: Config, session: string, result: ProjectResult, honcho = new Honcho(honchoClientOptions(config))) {
  if (result.status === "unknown") throw new Error(result.reason);
  const file = join(process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho"), "codex", "project-scopes", identityScope(config),
    createHash("sha256").update(session).digest("hex") + ".json");
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  // Exclusive creation handles the normal path. A separate short-lived guard
  // serializes stale-owner recovery; re-read after acquiring it, never unlink a
  // lock based on an earlier observation. An abandoned recovery guard fails closed.
  const token = `${process.pid}:${randomUUID()}`;
  try { writeFileSync(lock, token, { flag: "wx" }); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const guard = `${lock}.recovery`;
    writeFileSync(guard, token, { flag: "wx" });
    try {
      let old: string | undefined;
      try { old = readFileSync(lock, "utf8"); }
      catch (e: any) { if (e.code !== "ENOENT") throw e; }
      if (old !== undefined) {
        const pid = Number(old.split(":")[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid scope lock owner");
        try { process.kill(pid, 0); throw new Error("scope reconciliation busy"); }
        catch (e: any) { if (e.code !== "ESRCH") throw e; }
        unlinkSync(lock);
      }
      writeFileSync(lock, token, { flag: "wx" });
    } finally {
      if (readFileSync(guard, "utf8") === token) unlinkSync(guard);
    }
  }
  try {
    let previous: string[] = [];
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(raw) || !raw.every(x => typeof x === "string" && /^codex-project-[a-f0-9]{64}$/.test(x))) throw new Error("invalid scope journal");
      previous = raw;
    } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    const next = result.status === "project" ? projectScopeId(result) : undefined;
    const save = (scopes: string[]) => {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(scopes));
      renameSync(tmp, file);
    };
    save([...new Set([...previous, ...(next ? [next] : [])])]);
    // Detach old project before adding new one. Reconciliation is asynchronous server-side.
    for (const id of previous) if (id !== next) {
      try { await (await honcho.getScope(id)).removeSession(session); }
      catch (error: any) {
        // A previous creation may have failed after journaling but before the
        // scope existed. There is no membership to remove in that case.
        if (error.status !== 404) throw error;
      }
    }
    if (result.status === "project" && next) {
      const scope = await honcho.scope(next, { metadata: { source: "codex-desktop", projectId: result.id, projectName: result.label, hostId: result.hostId } });
      await scope.addSessions([session]);
    }
    save(next ? [next] : []);
  } finally { if (readFileSync(lock, "utf8") === token) unlinkSync(lock); }
}

export function scopeHint(result: ProjectResult | { status: "disabled" }): string {
  if (result.status === "project") return `Honcho project scope: ${JSON.stringify(projectScopeId(result))}. Use this scope on memory queries for this project. Omit scope only for an intentional cross-project lookup.`;
  if (result.status === "unknown") return "Honcho desktop project lookup unavailable; project-scoped memory was not loaded. Do not infer project membership from cwd.";
  if (result.status === "projectless") return "Honcho desktop chat has no project. Use unscoped memory queries; do not reuse a previous project scope.";
  return "";
}
