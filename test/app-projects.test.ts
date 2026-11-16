import { test, expect } from "bun:test";
import { appRequest, resolveChatProject } from "../src/app-projects.ts";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function api(pages: any[], projects: any[] = [{ projectId: "p", label: "Project", hostId: "local" }]) {
  const calls: any[] = [];
  const request = async (method: string, params: any) => {
    calls.push({ method, ...params });
    if (method === "tools/list") return { tools: ["list_threads", "list_projects"].map(name => ({ name, namespace: "codex_app" })) };
    const data = params.tool === "list_threads" ? pages.shift() : { projects };
    if (!data) throw new Error("unexpected page");
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] };
  };
  return { request, calls };
}
const chat = { id: "chat", kind: "codex", hostId: "local", projectId: "p", cwd: "/a/worktree" };
test("uses desktop project identity for worktrees, without cwd inference", async () => {
  const a = api([{ threads: [chat] }]);
  expect(await resolveChatProject("chat", a.request)).toEqual({ status: "project", id: "p", label: "Project", hostId: "local" });
  expect(a.calls.filter(c => c.method === "tools/call").map(c => c.tool)).toEqual(["list_threads", "list_projects"]);
});
test("paginates history and archives, preserving caller host", async () => {
  const a = api([{ threads: [] }, { threads: [], nextCursor: "next" }, { threads: [] }, { threads: [chat] }]);
  expect((await resolveChatProject("chat", a.request)).status).toBe("project");
  expect(a.calls.some(c => c.arguments?.cursor === "next")).toBe(true);
  expect(a.calls.some(c => c.arguments?.archived === true)).toBe(true);
});
test("only explicit null means projectless; omissions and missing IDs stay unknown", async () => {
  const a = api([{ threads: [{ ...chat, projectId: null }] }]);
  expect(await resolveChatProject("chat", a.request)).toEqual({ status: "projectless" });
  expect(a.calls.length).toBe(2);
  for (const pages of [[{ threads: [{ ...chat, projectId: undefined }] }], [{ threads: [] }, { threads: [] }, { threads: [] }]]) {
    expect((await resolveChatProject("chat", api(pages).request)).status).toBe("unknown");
  }
});
test("does not use another host's same chat ID; detects cursor loops and transport errors", async () => {
  const a = api([{ threads: [{ ...chat, hostId: "remote" }] }, { threads: [], nextCursor: "x" }, { threads: [], nextCursor: "x" }]);
  expect((await resolveChatProject("chat", a.request)).status).toBe("unknown");
  expect((await resolveChatProject("chat", async () => { throw Error("offline"); })).status).toBe("unknown");
});
test("pipe accepts fragmented frames and rejects oversized responses and timeouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "honcho-pipe-"));
  for (const mode of ["ok", "oversize", "timeout"]) {
    const pipe = join(dir, mode);
    const sockets = new Set<net.Socket>();
    const server = net.createServer(s => {
      sockets.add(s); s.on("close", () => sockets.delete(s));
      s.once("data", () => {
        if (mode === "timeout") return;
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
        const header = Buffer.alloc(4); header.writeUInt32LE(mode === "oversize" ? 9 * 1024 * 1024 : body.length);
        s.write(header.subarray(0, 2)); s.end(Buffer.concat([header.subarray(2), body]));
      });
    });
    await new Promise<void>(r => server.listen(pipe, r));
    try {
      const request = appRequest("tools/list", {}, { pipe, timeoutMs: 100 });
      if (mode === "ok") expect(await request).toEqual({ ok: true });
      else await expect(request).rejects.toThrow("HONCHO_PROJECT_LOOKUP_");
    } finally { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); }
  }
});
