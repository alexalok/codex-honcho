import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { HOOK_VERBS, type HookVerb } from "./connectors/codex.ts";

// Verbs that aren't Codex events — invoked internally or for manual draining.
export const INTERNAL_VERBS = ["flush"] as const;
export type Verb = HookVerb | (typeof INTERNAL_VERBS)[number];

export function isHookVerb(value: string): value is HookVerb {
  return (HOOK_VERBS as readonly string[]).includes(value);
}

export function isVerb(value: string): value is Verb {
  return isHookVerb(value) || (INTERNAL_VERBS as readonly string[]).includes(value);
}

// Helpers have no rollout. For persisted threads inspect only the session_meta
// header. Unknown metadata preserves existing hook behavior.
export function skipHook(transcriptPath: unknown): boolean {
  if (transcriptPath == null || transcriptPath === "") return true;
  if (typeof transcriptPath !== "string") return false;

  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return false;
    const chunks: Buffer[] = [];
    for (let size = 0; size < 256 * 1024;) {
      const buffer = Buffer.allocUnsafe(4096);
      const count = readSync(fd, buffer, 0, buffer.length, null);
      const bytes = buffer.subarray(0, count);
      const newline = bytes.indexOf(10);
      chunks.push(newline < 0 ? bytes : bytes.subarray(0, newline));
      if (newline >= 0 || count === 0) {
        const header = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return header?.type === "session_meta" && (
          header.payload?.thread_source === "guardian_review" ||
          header.payload?.source?.subagent?.other === "guardian"
        );
      }
      size += count;
    }
  } catch {
    // Rollout may still be initializing when the first hook runs.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return false;
}

// Route a hook verb to its handler. Every handler is best-effort: any failure
// resolves to an empty string so a hook never blocks or breaks a Codex turn.
export async function dispatch(verb: Verb, stdinText: string): Promise<string> {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(stdinText || "{}");
  } catch {
    return "";
  }

  try {
    if (isHookVerb(verb) && skipHook(input.transcript_path)) return "";
    switch (verb) {
      case "recall": {
        const { recall } = await import("./hooks/recall.ts");
        return await recall(input);
      }
      case "prompt": {
        const { prompt } = await import("./hooks/prompt.ts");
        return await prompt(input);
      }
      case "observe": {
        const { observe } = await import("./hooks/observe.ts");
        return await observe(input);
      }
      case "writeback": {
        const { writeback } = await import("./hooks/writeback.ts");
        return await writeback(input);
      }
      case "flush": {
        const { flush } = await import("./hooks/flush.ts");
        return await flush(input);
      }
    }
  } catch {
    return "";
  }
}
