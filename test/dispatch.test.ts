import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skipHook } from "../src/dispatch.ts";

test("ordinary, unavailable and unknown rollout headers remain eligible", () => {
  const dir = mkdtempSync(join(tmpdir(), "honcho-hook-"));
  const path = join(dir, "rollout.jsonl");
  try {
    expect(skipHook(path)).toBe(false);
    for (const header of [
      "invalid metadata",
      JSON.stringify({ type: "event_msg", payload: { thread_source: "guardian_review" } }),
      JSON.stringify({ type: "session_meta", payload: { source: { subagent: { thread_spawn: {} } } } }),
    ]) {
      writeFileSync(path, header + '\n' + '{"type":"session_meta","payload":{"thread_source":"guardian_review"}}');
      expect(skipHook(path)).toBe(false);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
