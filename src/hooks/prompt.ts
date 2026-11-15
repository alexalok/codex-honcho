import { loadConfig, memoryKey } from "../config.ts";
import { retrieveTaskMemory, renderTaskMemory } from "../memory.ts";
import { taskAlreadyInjected, markTaskInjected, taskRecallCompleted } from "../task-cache.ts";

interface PromptInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

const TRIVIAL = /^(y|n|yes|no|ok|okay|sure|thanks|thank you|yep|nope|continue|go ahead|do it|proceed|да|нет|ок|спасибо|продолжай)[.!?]*$/i;
const GENERATED = /^<(?:environment_context|turn_aborted|permissions|collaboration_mode|subagent_notification|codex_delegation|system-reminder|user_instructions)\b/i;

export function taskQuery(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  const text = prompt.trim();
  if (!text || TRIVIAL.test(text) || GENERATED.test(text)) return "";
  if (/^#\s*AGENTS\.md instructions(?:\s|$)/i.test(text) && /<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>/i.test(text)) return "";
  return text.replace(/\s+/g, " ").slice(0, 2000);
}

// Always recall on the first eligible prompt after SessionStart. The flag
// controls subsequent prompts only. No stale-context fallback.
export async function prompt(input: PromptInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";
  const query = taskQuery(input.prompt);
  if (!query) return "";
  const cwd = input.cwd || process.cwd();
  const key = memoryKey(config, cwd, input.session_id);
  if (!config.injectPerPrompt && taskRecallCompleted(config, key)) return "";
  try {
    const block = renderTaskMemory(await retrieveTaskMemory(config, query));
    if (taskAlreadyInjected(config, key, block)) return "";
    // An empty successful search completes initial recall, but must not
    // replace an existing injected-block digest used by repeated recall.
    if (block || !taskRecallCompleted(config, key)) markTaskInjected(config, key, block);
    return block;
  } catch {
    return "";
  }
}
