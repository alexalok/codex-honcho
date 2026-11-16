import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prompt, taskQuery } from "../../src/hooks/prompt.ts";
import { recall } from "../../src/hooks/recall.ts";
import { writeContext } from "../../src/cache.ts";

let dir = "";
const savedDir = process.env.HONCHO_CONFIG_DIR;
const savedKey = process.env.HONCHO_API_KEY;
let requests: { path: string; body: any }[];
let facts: string[];
let fail = false;
let server: ReturnType<typeof Bun.serve>;
function writeConfig(extra: object = {}) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "test", peerName: "testuser", saveMessages: false, injectPerPrompt: true,
    endpoint: { baseUrl: `http://127.0.0.1:${server.port}` }, ...extra }));
}
const input = { prompt: "How does project auth refresh tokens?", cwd: "/tmp/x", session_id: "s1" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-prompt-"));
  process.env.HONCHO_CONFIG_DIR = dir;
  delete process.env.HONCHO_API_KEY;
  requests = []; facts = ["Auth refresh uses rotating tokens."]; fail = false;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json() : null;
    requests.push({ path, body });
    if (fail) return Response.json({ message: "unavailable" }, { status: 503 });
    if (path.endsWith("/conclusions/query")) return Response.json(facts.map((content, i) => ({
      id: String(i), content, observer_id: "testuser", observed_id: "testuser", session_id: "old", created_at: "2026-01-01T00:00:00Z"
    })));
    return Response.json({ id: body?.id || "codex", metadata: {}, configuration: {} });
  }});
  writeConfig();
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR; else process.env.HONCHO_CONFIG_DIR = savedDir;
  if (savedKey === undefined) delete process.env.HONCHO_API_KEY; else process.env.HONCHO_API_KEY = savedKey;
});

test("opted-in prompt retrieval sends task query, threshold and peer identity, never profile request", async () => {
  const out = await prompt(input);
  expect(out).toContain("Auth refresh uses rotating tokens.");
  expect(out).not.toContain('peer=');
  const search = requests.find(r => r.path.endsWith("/conclusions/query"));
  expect(search?.body).toEqual({ query: input.prompt, top_k: 6, distance: 0.5,
    filters: { observer_id: "testuser", observed_id: "testuser" } });
  expect(requests.some(r => /context|representation/.test(r.path))).toBe(false);
});
test("default and explicit false recall initially but skip later prompts", async () => {
  for (const injectPerPrompt of [undefined, false]) {
    writeConfig({ injectPerPrompt });
    const turn = { ...input, session_id: String(injectPerPrompt) };
    expect(await prompt(turn)).toContain("rotating tokens");
    const count = requests.length;
    expect(await prompt({ ...turn, prompt: "Which DB does this project use?" })).toBe("");
    expect(requests).toHaveLength(count);
  }
});
test("disabled integration makes no requests", async () => {
  writeConfig({ enabled: false }); expect(await prompt(input)).toBe("");
  expect(requests).toHaveLength(0);
});
test("skipped prompts do not consume initial recall", async () => {
  writeConfig({ injectPerPrompt: false });
  expect(await prompt({ ...input, prompt: "ok" })).toBe("");
  expect(await prompt({ ...input, prompt: "<environment_context>generated</environment_context>" })).toBe("");
  expect(requests).toHaveLength(0);
  expect(await prompt(input)).toContain("rotating tokens");
});
test("empty successful search completes initial recall, failures allow retry", async () => {
  writeConfig({ injectPerPrompt: false });
  fail = true; expect(await prompt(input)).toBe("");
  fail = false; facts = []; expect(await prompt(input)).toBe("");
  const count = requests.length;
  facts = ["A new fact"];
  expect(await prompt(input)).toBe("");
  expect(requests).toHaveLength(count);
});
test("trivial and generated prompts make no requests; human AGENTS questions survive", async () => {
  for (const text of ["", "ok!", "continue", "да", "<environment_context>stuff</environment_context>",
    "<turn_aborted/>", "<codex_delegation>generated</codex_delegation>",
    "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>rules</INSTRUCTIONS>"]) {
    expect(await prompt({ ...input, prompt: text })).toBe("");
  }
  expect(requests).toHaveLength(0);
  expect(taskQuery("Explain AGENTS.md instructions")).toBe("Explain AGENTS.md instructions");
  expect(taskQuery("# AGENTS.md instructions\nPlease fix this file")).not.toBe("");
  expect(taskQuery("x".repeat(3000))).toHaveLength(2000);
});
test("legacy generic caches ignored; empty query results have no fallback", async () => {
  writeContext("s1", "Generic preference", ["Profile secret"]);
  facts = [];
  expect(await prompt(input)).toBe("");
  expect(requests.some(r => r.path.endsWith("/conclusions/query"))).toBe(true);
});
test("duplicates collapse, repeated blocks suppressed, different task queries fetched", async () => {
  facts = ["Auth refresh uses rotating tokens.", " - Auth   refresh uses rotating tokens."];
  expect((await prompt(input)).match(/rotating tokens/g)).toHaveLength(1);
  expect(await prompt(input)).toBe("");
  facts = ["DB uses SQLite."];
  expect(await prompt({ ...input, prompt: "Which DB stores project data?" })).toContain("DB uses SQLite.");
  expect(requests.filter(r => r.path.endsWith("/conclusions/query"))).toHaveLength(3);
});
test("API failures return empty without fallback or poisoning later retry", async () => {
  writeContext("s1", "Generic preference", ["Profile secret"]);
  fail = true; expect(await prompt(input)).toBe("");
  fail = false; expect(await prompt(input)).toContain("rotating tokens");
});
test("SessionStart only gives tool hint/link and rearms initial recall with repeat disabled", async () => {
  writeConfig({ injectPerPrompt: false });
  await prompt(input);
  requests = [];
  const out = await recall(input);
  expect(out).toContain("Honcho memory tools");
  expect(out).not.toContain("<honcho-memory");
  expect(out).not.toContain("get_peer_context");
  expect(requests.some(r => /context|representation|conclusions/.test(r.path))).toBe(false);
  expect(await prompt(input)).toContain("rotating tokens");
});
test("SessionStart keeps tool hint during API outage", async () => {
  // A non-retryable rejection keeps this failure test fast.
  server.stop(true);
  expect(await recall(input)).toContain("Honcho memory tools");
});


test("empty searches preserve last injected block for repeat recall dedup", async () => {
  expect(await prompt(input)).toContain("rotating tokens");
  facts = []; expect(await prompt(input)).toBe("");
  facts = ["Auth refresh uses rotating tokens."];
  expect(await prompt(input)).toBe("");
  expect(requests.filter(r => r.path.endsWith("/conclusions/query"))).toHaveLength(3);
});
