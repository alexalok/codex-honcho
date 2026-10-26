import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { attributeDelegation, recordSessionIdentity, unknownDelegationPeer } from "../src/session-identity.ts";
import { splitDelegations } from "../src/transcript/delegation.ts";
import { SOURCE, UNKNOWN, wrapper } from "./fixtures/delegation.ts";

const original = process.env.HONCHO_CONFIG_DIR;
let dir: string;
const config: Config = {
  apiKey: "fixture-only", workspace: "fixture-workspace", peerName: "alex", aiPeer: "codex-overseer",
  enabled: true, saveMessages: true, reasoningLevel: "low", injectPerPrompt: false,
  sessionStrategy: "chat-instance", endpoint: { baseUrl: "http://127.0.0.1:1/v3" },
};
const task = (source = SOURCE) => splitDelegations(wrapper("synthetic task", source), "user-message")[0];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-identity-"));
  process.env.HONCHO_CONFIG_DIR = dir;
});
afterEach(() => {
  if (original === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = original;
  rmSync(dir, { recursive: true, force: true });
});

test("resolves a hook-observed source session to its own configured AI peer", () => {
  recordSessionIdentity({ ...config, aiPeer: "steve", sessions: { "/fixture/source": "mapped-source-session" } }, "/fixture/source", SOURCE);
  const resolved = attributeDelegation(task(), config);
  expect(resolved.delegation?.sender).toMatchObject({ peer: "steve", session: "mapped-source-session" });
  expect(resolved.role).toBe("delegation");
});

test("unobserved UUIDs and unrelated session-name mappings never imply a named sender", () => {
  const mapped = { ...config, sessions: { "/fixture/source": "shared-name" } };
  recordSessionIdentity(mapped, "/fixture/source", SOURCE);
  expect(attributeDelegation(task(UNKNOWN), mapped).delegation?.sender).toBeUndefined();
  expect(attributeDelegation(task(), config).delegation?.sender?.peer).toBe("codex-overseer");
});

test("identity evidence is isolated by endpoint and workspace", () => {
  recordSessionIdentity(config, "/fixture/source", SOURCE);
  expect(attributeDelegation(task(), { ...config, workspace: "different" }).delegation?.sender).toBeUndefined();
  expect(attributeDelegation(task(), { ...config, endpoint: { baseUrl: "http://127.0.0.1:2/v3" } }).delegation?.sender).toBeUndefined();
});

test("conflicting session identities remain unknown even after the old configuration returns", () => {
  recordSessionIdentity(config, "/fixture/source", SOURCE);
  recordSessionIdentity({ ...config, aiPeer: "steve" }, "/fixture/source", SOURCE);
  recordSessionIdentity(config, "/fixture/source", SOURCE);
  expect(attributeDelegation(task(), config).delegation?.sender).toBeUndefined();
});

test("never resolves a source to the current human or a recorded human peer", () => {
  recordSessionIdentity({ ...config, aiPeer: "alex" }, "/fixture/source", SOURCE);
  expect(attributeDelegation(task(), config).delegation?.sender).toBeUndefined();
  recordSessionIdentity({ ...config, peerName: "another-human", aiPeer: "alex" }, "/fixture/source", UNKNOWN);
  expect(attributeDelegation(task(UNKNOWN), config).delegation?.sender).toBeUndefined();
});

test("unknown delegation peer cannot collide with either configured conversational peer", () => {
  expect(unknownDelegationPeer(config)).toBe("codex-delegation-unknown");
  expect(unknownDelegationPeer({ ...config, peerName: "codex-delegation-unknown", aiPeer: "codex-delegation-unknown-unknown" }))
    .toBe("codex-delegation-unknown-unknown-unknown");
});
