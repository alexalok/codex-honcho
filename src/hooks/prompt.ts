import { loadConfig, sessionName, memoryKey } from "../config.ts";
import { resolveScope, projectScopeId, scopeHint } from "../project-scope.ts";
import { recall } from "./recall.ts";
import { renderContext } from "../memory.ts";
import { readContext, writeContext, lastInjected, markInjected } from "../cache.ts";

interface PromptInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

const TRIVIAL = /^(y|n|yes|no|ok|okay|sure|thanks|yep|nope|continue|go ahead|do it|proceed)\.?$/i;

// UserPromptSubmit: off by default — session-start context plus the MCP tools
// cover recall without taxing every turn. When injectPerPrompt is enabled,
// serve the cached snapshot (no network) and never repeat the same block.
export async function prompt(input: PromptInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";
  const cwd = input.cwd || process.cwd();
  const key = memoryKey(config, cwd, input.session_id);

  // Refresh project context on moves even when per-prompt memory injection is off.
  if (config.scopeStrategy === "desktop-project") {
    const project = await resolveScope(config, input.session_id);
    if (project.status === "unknown") {
      writeContext(key, null, null);
      return scopeHint(project);
    }
    const boundary = project.status === "project" ? projectScopeId(project) : project.status;
    if (readContext(key)?.boundary !== boundary) return recall(input);
  }
  if (!config.injectPerPrompt) return "";
  const text = (input.prompt ?? "").trim();
  if (!text || TRIVIAL.test(text)) return "";

  const cached = readContext(key);
  if (!cached) return "";

  const block = renderContext(cached, config.peerName, 5);
  if (!block || block === lastInjected(key)) return "";

  markInjected(key, block);
  return block;
}
