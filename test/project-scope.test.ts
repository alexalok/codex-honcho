import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectScopeId, syncProjectScope } from "../src/project-scope.ts";
import type { Config } from "../src/config.ts";

test("project scope identity survives rename and separates hosts", () => {
  const a = { status: "project" as const, id: "p", label: "Old", hostId: "local" };
  expect(projectScopeId(a)).toBe(projectScopeId({ ...a, label: "New" }));
  expect(projectScopeId(a)).not.toBe(projectScopeId({ ...a, hostId: "remote" }));
});
test("membership reconciles moves/projectless and recovers after interrupted addition", async () => {
  const before = process.env.HONCHO_CONFIG_DIR;
  process.env.HONCHO_CONFIG_DIR = mkdtempSync(join(tmpdir(), "honcho-scope-"));
  const config = { apiKey: "test", workspace: "test" } as Config;
  const actions: string[] = [];
  let fail = false;
  const client: any = {
    scope: async (id: string) => ({ addSessions: async () => { actions.push(`add:${id}`); if (fail) throw Error("offline"); } }),
    getScope: async (id: string) => ({ removeSession: async () => { actions.push(`remove:${id}`); } }),
  };
  const a = { status: "project" as const, id: "a", label: "A", hostId: "local" };
  const b = { ...a, id: "b", label: "B" };
  try {
    await syncProjectScope(config, "chat", a, client);
    fail = true;
    await expect(syncProjectScope(config, "chat", b, client)).rejects.toThrow("offline");
    fail = false;
    await syncProjectScope(config, "chat", { status: "projectless" }, client);
    expect(actions).toEqual([`add:${projectScopeId(a)}`, `remove:${projectScopeId(a)}`, `add:${projectScopeId(b)}`, `remove:${projectScopeId(a)}`, `remove:${projectScopeId(b)}`]);
    const n = actions.length;
    await expect(syncProjectScope(config, "chat", { status: "unknown", reason: "lookup failed" }, client)).rejects.toThrow();
    expect(actions.length).toBe(n);
  } finally {
    if (before === undefined) delete process.env.HONCHO_CONFIG_DIR; else process.env.HONCHO_CONFIG_DIR = before;
  }
});

test("concurrent hooks cannot steal an active reconciliation lock", async () => {
  const before = process.env.HONCHO_CONFIG_DIR;
  process.env.HONCHO_CONFIG_DIR = mkdtempSync(join(tmpdir(), "honcho-scope-lock-"));
  const config = { apiKey: "test", workspace: "test" } as Config;
  const project = { status: "project" as const, id: "p", label: "P", hostId: "local" };
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(r => entered = r);
  const blocked = new Promise<void>(r => unblock = r);
  let calls = 0;
  const client: any = { scope: async () => ({ addSessions: async () => { calls++; entered(); await blocked; } }) };
  try {
    const first = syncProjectScope(config, "chat", project, client);
    await started;
    await expect(syncProjectScope(config, "chat", project, client)).rejects.toThrow("busy");
    expect(calls).toBe(1);
    unblock(); await first;
    await syncProjectScope(config, "chat", project, client);
    expect(calls).toBe(2);
  } finally {
    unblock();
    if (before === undefined) delete process.env.HONCHO_CONFIG_DIR; else process.env.HONCHO_CONFIG_DIR = before;
  }
});
