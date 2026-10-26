import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capture } from "../../src/hooks/writeback.ts";
import { readQueue, pendingCount } from "../../src/queue.ts";
import { readCaptureCursor, writeCursor } from "../../src/cursor.ts";
import { loadConfig } from "../../src/config.ts";
import { recordSessionIdentity } from "../../src/session-identity.ts";
import { SOURCE, UNKNOWN, AT, modern, message, wrapper } from "../fixtures/delegation.ts";

const savedDir = process.env.HONCHO_CONFIG_DIR;
let rollout = "";

function writeRollout(turns: Array<{ role: string; text: string }>) {
  const lines = turns.map((t) => ({
    type: "response_item",
    payload: { type: "message", role: t.role, content: [{ type: t.role === "user" ? "input_text" : "output_text", text: t.text }] },
  }));
  writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "codex-honcho-wb-"));
  process.env.HONCHO_CONFIG_DIR = dir;
  rollout = join(dir, "rollout.jsonl");
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
});

test("capture enqueues fresh turns and is incremental across calls", () => {
  writeRollout([{ role: "user", text: "first" }, { role: "assistant", text: "reply" }]);
  expect(capture("s1", rollout)).toBe(2);
  expect(readQueue("s1").map((e) => e.text)).toEqual(["first", "reply"]);

  // Second call with no new turns enqueues nothing.
  expect(capture("s1", rollout)).toBe(0);

  // A new turn appears → only the delta is captured.
  writeRollout([
    { role: "user", text: "first" },
    { role: "assistant", text: "reply" },
    { role: "user", text: "second" },
  ]);
  expect(capture("s1", rollout)).toBe(1);
  expect(pendingCount("s1")).toBe(3);
  expect(readQueue("s1").at(-1)?.text).toBe("second");
});

test("capture skips Codex-injected system turns", () => {
  writeRollout([
    { role: "user", text: "<environment_context><cwd>/x</cwd></environment_context>" },
    { role: "user", text: "real prompt" },
  ]);
  expect(capture("s2", rollout)).toBe(1);
  expect(readQueue("s2").map((e) => e.text)).toEqual(["real prompt"]);
});

function events(lines: object[]) {
  writeFileSync(rollout, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

test("both delegation transports survive repeated capture, alongside normal turns", () => {
  events([
    message("human"), modern(wrapper("modern")), message("answer", "assistant"),
    message(wrapper("compatibility", UNKNOWN)),
  ]);
  expect(capture("s1", rollout)).toBe(4);
  expect(capture("s1", rollout)).toBe(0);
  expect(readQueue("s1").map((e) => [e.role, e.text])).toEqual([
    ["user", "human"], ["delegation", "modern"], ["assistant", "answer"], ["delegation", "compatibility"],
  ]);
  expect(readQueue("s1")[1]).toMatchObject({ at: AT, delegation: { sourceThreadId: SOURCE, transport: "tool-output" } });
  appendFileSync(rollout, JSON.stringify(modern(wrapper("modern"))) + "\n");
  // The same task intentionally delivered in a later event is a new message.
  expect(capture("s1", rollout)).toBe(1);
  expect(capture("s1", rollout)).toBe(0);
});

test("capture snapshots verified identity and preserves unknown source provenance", () => {
  writeFileSync(join(process.env.HONCHO_CONFIG_DIR!, "config.json"), JSON.stringify({
    apiKey: "fixture-only", peerName: "alex", aiPeer: "root-fallback",
    hosts: { codex: { aiPeer: "codex-overseer" } }, sessions: { "/fixture/source": "known-source" },
  }));
  const config = loadConfig()!;
  recordSessionIdentity(config, "/fixture/source", SOURCE);
  events([modern(wrapper("known")), message(wrapper("unknown", UNKNOWN))]);
  expect(capture("s1", rollout, config)).toBe(2);
  const [known, unknown] = readQueue("s1");
  expect(known.delegation?.sender).toMatchObject({ peer: "codex-overseer", session: "known-source" });
  expect(unknown.delegation?.sourceThreadId).toBe(UNKNOWN);
  expect(unknown.delegation?.sender).toBeUndefined();
  expect(unknown.role).toBe("delegation");
});

test("migrates a legacy message-count cursor without shifted duplicates or historical backfill", () => {
  events([
    message("already captured human"),
    modern(wrapper("previously ignored tool output")),
    message(wrapper("already captured compatibility wrapper")),
    message("already captured answer", "assistant"),
    modern(wrapper("new modern task")),
    message(wrapper("new compatibility task")),
    message("new answer", "assistant"),
  ]);
  writeCursor("s1", 3);
  expect(capture("s1", rollout)).toBe(3);
  expect(readQueue("s1").map((e) => e.text)).toEqual(["new modern task", "new compatibility task", "new answer"]);
  expect(readCaptureCursor("s1")).toEqual({ count: 7, format: "rollout-items-v2" });
  expect(capture("s1", rollout)).toBe(0);
});

test("migrates at an unchanged tail before subsequent modern delivery", () => {
  events([modern(wrapper("old ignored tool")), message("old human")]);
  writeCursor("s1", 1);
  expect(capture("s1", rollout)).toBe(0);
  expect(readCaptureCursor("s1")).toEqual({ count: 2, format: "rollout-items-v2" });
  appendFileSync(rollout, JSON.stringify(modern(wrapper("new task"))) + "\n");
  expect(capture("s1", rollout)).toBe(1);
  expect(readQueue("s1").map((e) => e.text)).toEqual(["new task"]);
});

test("mixed content consumes one cursor item even though it produces multiple queue entries", () => {
  events([message(`human prefix\n${wrapper("delegated task")}\nhuman suffix`)]);
  expect(capture("s1", rollout)).toBe(3);
  expect(readCaptureCursor("s1").count).toBe(1);
  expect(capture("s1", rollout)).toBe(0);
  appendFileSync(rollout, JSON.stringify(message("next")) + "\n");
  expect(capture("s1", rollout)).toBe(1);
  expect(readQueue("s1").map((e) => e.text)).toEqual(["human prefix", "delegated task", "human suffix", "next"]);
});

test("shrunken transcripts replay the full set with delegation provenance intact", () => {
  events([message("a"), modern(wrapper("b")), message("c")]);
  expect(capture("s1", rollout)).toBe(3);
  events([message(wrapper("after clear", UNKNOWN))]);
  expect(capture("s1", rollout)).toBe(1);
  expect(readQueue("s1").at(-1)).toMatchObject({ role: "delegation", text: "after clear", delegation: { sourceThreadId: UNKNOWN } });
  expect(capture("s1", rollout)).toBe(0);
});

test("a missing rollout does not erase a cursor and duplicate the tail on recovery", () => {
  events([message("already captured")]);
  expect(capture("s1", rollout)).toBe(1);
  expect(capture("s1", `${rollout}.missing`)).toBe(0);
  expect(capture("s1", rollout)).toBe(0);
});

test("malformed wrappers and ignored tool outputs do not destabilize deduplication", () => {
  const malformed = "<codex_delegation><input>unfinished";
  events([modern(malformed), modern("ignored"), message(malformed), message("normal")]);
  expect(capture("s1", rollout)).toBe(3);
  expect(capture("s1", rollout)).toBe(0);
  expect(readQueue("s1").map((e) => e.role)).toEqual(["delegation", "delegation", "user"]);
});
