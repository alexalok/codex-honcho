// Pipe transport adapted from alexalok/jev-skill-router PR #4.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
const fail = (code: string) => new Error(code);

// Same app-facing pipe protocol as bundled codex-app-tools/server.mjs.
// Keep this adapter read-only; no private app database/config fallback.
export async function appRequest(method: string, params: Record<string, unknown>, { pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH, timeoutMs = 3000 } = {}) {
  if (!pipe || !isAbsolute(pipe)) throw fail('HONCHO_PROJECT_LOOKUP_UNAVAILABLE');
  return new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let data = Buffer.alloc(0), settled = false;
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(fail('HONCHO_PROJECT_LOOKUP_TIMEOUT')), timeoutMs);
    socket.on('error', () => finish(fail('HONCHO_PROJECT_LOOKUP_UNAVAILABLE')));
    socket.on('close', () => finish(fail('HONCHO_PROJECT_LOOKUP_UNAVAILABLE')));
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (data.length > 8 * 1024 * 1024 + 4) return finish(fail('HONCHO_PROJECT_LOOKUP_INVALID'));
      if (data.length < 4) return;
      const size = data.readUInt32LE(0);
      if (!size || size > 8 * 1024 * 1024) return finish(fail('HONCHO_PROJECT_LOOKUP_INVALID'));
      if (data.length < size + 4) return;
      try {
        const response = JSON.parse(data.subarray(4, size + 4).toString("utf8"));
        if (response.jsonrpc !== '2.0' || response.id !== 1 || response.error || !Object.hasOwn(response, 'result')) throw Error();
        finish(null, response.result);
      } catch { finish(fail('HONCHO_PROJECT_LOOKUP_INVALID')); }
    });
  });
}

export type ProjectResult =
  | { status: "project"; id: string; label: string; hostId: string }
  | { status: "projectless" }
  | { status: "unknown"; reason: string };

// Each lookup has a total budget, including all history pages. Never guess from cwd.
export async function resolveChatProject(
  threadId?: string,
  request = appRequest,
  hostId = process.env.CODEX_APP_TOOLS_CALLER_HOST_ID || "local",
): Promise<ProjectResult> {
  if (!threadId) return { status: "unknown", reason: "missing chat ID" };
  const deadline = Date.now() + 8000;
  try {
    const rpc = (method: string, params: Record<string, unknown>) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("project lookup deadline exceeded");
      return request(method, params, { timeoutMs: Math.min(3000, remaining) });
    };
    const catalog = await rpc("tools/list", { threadStartKind: "all" });
    async function call(name: string, args: Record<string, unknown>) {
      const tool = catalog?.tools?.find((t: any) => t.name === name);
      if (typeof tool?.namespace !== "string") throw new Error(`missing ${name}`);
      const result = await rpc("tools/call", {
        arguments: args, callerSource: "codex", callId: `honcho-${randomUUID()}`,
        hostId, namespace: tool.namespace, threadId, tool: name, turnId: `honcho-${randomUUID()}`,
      });
      if (result?.success !== true) throw new Error(`${name} failed`);
      return JSON.parse(result.contentItems.find((i: any) => i.type === "inputText").text);
    }
    const match = (rows: any[]) => {
      if (!Array.isArray(rows)) throw new Error("invalid thread list");
      const matches = rows.filter(t => t.id === threadId && t.kind === "codex" && t.hostId === hostId);
      // Some app versions may include pinned chats in both collections.
      // Repeated identity is harmless; conflicting membership is not.
      if (matches.some(t => t.projectId !== matches[0].projectId)) throw new Error("ambiguous chat");
      return matches[0];
    };
    const recent = await call("list_threads", { limit: 50 });
    let thread = match([...(recent.threads || []), ...(recent.pinnedThreads || [])]);
    for (const archived of [false, true]) {
      if (thread) break;
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const result = await call("list_threads", { mode: "history", source: "codex", hostId, archived, limit: 50, ...(cursor ? { cursor } : {}) });
        thread = match(result.threads);
        if (thread || result.nextCursor == null) break;
        if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor)) throw new Error("invalid history cursor");
        cursor = result.nextCursor;
        seen.add(cursor!);
      }
    }
    if (!thread) throw new Error("chat not found");
    if (thread.projectId === null) return { status: "projectless" };
    if (typeof thread.projectId !== "string" || !thread.projectId) throw new Error("missing project assignment");
    const projects = (await call("list_projects", {})).projects;
    if (!Array.isArray(projects)) throw new Error("invalid project list");
    const matches = projects.filter(p => p.projectId === thread.projectId && p.hostId === hostId);
    if (matches.length !== 1 || typeof matches[0].label !== "string") throw new Error("project not found");
    return { status: "project", id: thread.projectId, label: matches[0].label, hostId };
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message : "project lookup failed" };
  }
}
