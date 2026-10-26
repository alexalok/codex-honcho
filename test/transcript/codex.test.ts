import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readRollout, readRolloutCwd } from "../../src/transcript/codex.ts";
import { AT, SOURCE, modern, message, wrapper } from "../fixtures/delegation.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/codex-rollout.jsonl", import.meta.url));

function writeRollout(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-honcho-"));
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

test("reads user and assistant turns in order", () => {
  const turns = readRollout(FIXTURE);
  expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(turns[0].text).toBe("How is auth handled in this repo?");
  expect(turns[1].text).toContain("JWT middleware");
});

test("ignores reasoning, function_call, and non-response_item events", () => {
  const turns = readRollout(FIXTURE);
  expect(turns.every((t) => !t.text.includes("chain of thought"))).toBe(true);
  expect(turns.length).toBe(4);
});

test("joins multiple input_text blocks", () => {
  const turns = readRollout(FIXTURE);
  expect(turns[2].text).toBe("Add a refresh token flow.\nKeep it backwards compatible.");
});

test("accepts string content as well as block arrays", () => {
  const turns = readRollout(FIXTURE);
  expect(turns[3].text).toContain("/refresh endpoint");
});

test("drops whitespace-only messages", () => {
  // The trailing assistant turn in the fixture is blank and must not appear.
  const turns = readRollout(FIXTURE);
  expect(turns.length).toBe(4);
});

test("carries timestamps through", () => {
  const turns = readRollout(FIXTURE);
  expect(turns[0].at).toBe("2026-06-05T12:00:01.000Z");
});

test("extracts cwd from session_meta", () => {
  expect(readRolloutCwd(FIXTURE)).toBe("/Users/dev/project");
});

test("missing file yields no turns and no cwd", () => {
  expect(readRollout("/no/such/rollout.jsonl")).toEqual([]);
  expect(readRolloutCwd("/no/such/rollout.jsonl")).toBeUndefined();
});

test("drops Codex-injected system turns (environment_context, etc.)", () => {
  const path = writeRollout([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>interrupted</turn_aborted>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skills_instructions>use skills</skills_instructions>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual question from me" }] } },
  ]);
  const turns = readRollout(path);
  expect(turns).toHaveLength(1);
  expect(turns[0].text).toBe("actual question from me");
});

test("skips malformed lines without throwing", () => {
  const path = writeRollout([
    { type: "session_meta", payload: { cwd: "/tmp/x" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
  ]);
  // Append a broken line.
  writeFileSync(path, "not json\n", { flag: "a" });
  const turns = readRollout(path);
  expect(turns).toHaveLength(1);
  expect(turns[0].text).toBe("hi");
});

test("captures only the incoming desktop tool output, preserving source and timestamp", () => {
  const turns = readRollout(writeRollout([modern(wrapper("Review the fixture & report <results>."))]));
  expect(turns).toEqual([{
    role: "delegation", text: "Review the fixture & report <results>.", at: AT,
    delegation: { transport: "tool-output", wrapper: "valid", sourceThreadId: SOURCE },
  }]);
});

test("accepts Responses input_text tool output blocks, ignoring nontext blocks", () => {
  const turns = readRollout(writeRollout([modern([
    { type: "input_image", image_url: "data:image/png;base64,fixture" },
    { type: "input_text", text: wrapper("First task.") },
    { type: "input_text", text: wrapper("Second task.") },
  ], { id: "fco_fixture", call_id: null })]));
  expect(turns.map((t) => t.text)).toEqual(["First task.", "Second task."]);
  expect(turns.every((t) => t.role === "delegation")).toBe(true);
});

test("compatibility wrappers are agent-origin even though transport has role user", () => {
  const turns = readRollout(writeRollout([message([{ type: "input_text", text: wrapper("Follow up.") }])]));
  expect(turns).toEqual([{
    role: "delegation", text: "Follow up.", at: AT,
    delegation: { transport: "user-message", wrapper: "valid", sourceThreadId: SOURCE },
  }]);
});

test("decodes escaped values once without interpreting the decoded task as context or markup", () => {
  const text = " \n<environment_context>task &amp; &lt; </input> <codex_delegation> ✓</environment_context>\n ";
  const turns = readRollout(writeRollout([modern(wrapper(text)), message(wrapper(text))]));
  expect(turns.map((t) => t.text)).toEqual([text, text]);
  expect(turns.every((t) => t.role === "delegation")).toBe(true);
});

test("splits mixed human and delegated text in order; assistant quotations stay assistant", () => {
  const turns = readRollout(writeRollout([
    message([
      { type: "input_text", text: "My own request." },
      { type: "input_image", image_url: "fixture" },
      { type: "input_text", text: wrapper("Agent request.") },
      { type: "input_text", text: "My follow-up." },
    ]),
    message(wrapper("Quoted by assistant."), "assistant"),
  ]));
  expect(turns.map((t) => [t.role, t.text])).toEqual([
    ["user", "My own request."], ["delegation", "Agent request."],
    ["user", "My follow-up."], ["assistant", wrapper("Quoted by assistant.")],
  ]);
});

test("tool-output surrounding text is never a human message", () => {
  const turns = readRollout(writeRollout([modern(`Forwarded:\n${wrapper("Task.")}\nDelivery complete.`)]));
  expect(turns.map((t) => t.text)).toEqual(["Forwarded:", "Task.", "Delivery complete."]);
  expect(turns.every((t) => t.role === "delegation")).toBe(true);
});

test("malformed wrappers retain evidence under unknown delegation, never a human or partial identity", () => {
  const malformed = [
    "<codex_delegation>",
    "</codex_delegation>",
    "<codex_delegation", // truncated opening tag
    wrapper("task", "alex"),
    wrapper("task", "../../peer"),
    wrapper(""),
    wrapper("task").replace("<input>task</input>", "<input>task &broken;</input>"),
    wrapper("task").replace("<input>task</input>", "<input>task <raw>markup</raw></input>"),
    wrapper("task").replace("<input>", "<input><input>"),
    wrapper("task").replace("</input>", ""),
    wrapper("task").replace("</codex_delegation>", ""),
    `<codex_delegation>${wrapper("nested task")}more task</codex_delegation>`,
  ];
  for (const text of malformed) {
    for (const event of [modern(text), message(text)]) {
      const turns = readRollout(writeRollout([event]));
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ role: "delegation", text, delegation: { wrapper: "malformed" } });
      expect(turns[0].delegation?.sourceThreadId).toBeUndefined();
    }
  }
});

test("does not ingest arbitrary, paired, custom, or mislabeled tool outputs", () => {
  const turns = readRollout(writeRollout([
    modern(wrapper("arbitrary"), { name: "exec_command", namespace: "functions" }),
    modern(wrapper("wrong namespace"), { namespace: "unrelated" }),
    modern(wrapper("missing namespace"), { namespace: undefined }),
    modern(wrapper("paired output"), { call_id: "call_fixture" }),
    modern(wrapper("custom"), { type: "custom_tool_call_output" }),
    modern("Generic tool result without a delegation wrapper"),
    modern([{ type: "text", text: wrapper("MCP content is not a Responses output block") }]),
    { type: "event_msg", payload: { message: wrapper("duplicate event notification") } },
  ]));
  expect(turns).toEqual([]);
});

test("malformed JSON payloads and blocks do not break later normal conversation", () => {
  const path = writeRollout([
    [], { type: "response_item", payload: null },
    modern(null), modern({ content: wrapper("opaque") }),
    modern([null, 1, "text", { type: "input_text", text: 42 }]),
    message([null, {}, 1, { type: "input_text", text: "normal" }]),
    message("answer", "assistant"),
  ]);
  writeFileSync(path, "null\nfalse\n42\n\"text\"\n", { flag: "a" });
  expect(readRollout(path).map((t) => [t.role, t.text])).toEqual([["user", "normal"], ["assistant", "answer"]]);
});

test("ordinary human examples of the wrapper in prose, fences, and blockquotes stay human", () => {
  const examples = [
    `Please explain this wrapper: ${wrapper("quoted task")}`,
    `Example:\n\`\`\`xml\n${wrapper("quoted task")}\n\`\`\`\nExplain it.`,
    `~~~xml\n${wrapper("quoted task")}\n~~~`,
    `> ${wrapper("quoted task")}`,
    "The literal <codex_delegation> opener needs escaping.",
  ];
  const turns = readRollout(writeRollout(examples.map((text) => message(text))));
  expect(turns.map((t) => t.text)).toEqual(examples);
  expect(turns.every((t) => t.role === "user" && t.delegation === undefined)).toBe(true);
});

test("filters injected context and developer messages before considering delegation syntax", () => {
  const turns = readRollout(writeRollout([
    message(`<environment_context>\n${wrapper("injected")}\n</environment_context>`),
    message(wrapper("developer context"), "developer"),
    message("ordinary human request"),
  ]));
  expect(turns.map((t) => [t.role, t.text])).toEqual([["user", "ordinary human request"]]);
});
