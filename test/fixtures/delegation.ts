// Synthetic messages only. Shapes checked against the CLI 0.164.0 generated
// TurnStartParams/RawResponseItemCompletedNotification schemas; the envelope
// follows desktop send_message_to_thread's escaped sourceThreadId/input format.
export const SOURCE = "11111111-1111-4111-8111-111111111111";
export const UNKNOWN = "22222222-2222-4222-8222-222222222222";
export const AT = "2026-06-09T12:00:00.000Z";

export function wrapper(text: string, source = SOURCE): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<codex_delegation><source_thread_id>${escape(source)}</source_thread_id><input>${escape(text)}</input></codex_delegation>`;
}

export function modern(output: unknown = wrapper("Inspect the fixture."), extra: object = {}) {
  return {
    type: "response_item", timestamp: AT,
    payload: { type: "function_call_output", name: "send_message_to_thread", namespace: "codex_app", output, ...extra },
  };
}

export function message(content: unknown, role = "user") {
  return { type: "response_item", timestamp: AT, payload: { type: "message", role, content } };
}
