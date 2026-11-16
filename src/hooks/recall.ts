import { loadConfig, sessionName, memoryKey, honchoSessionUrl } from "../config.ts";
import { createSession, renderContext } from "../memory.ts";
import { readContext, writeContext, isStale, markInjected } from "../cache.ts";
import { recallContext } from "../recall-context.ts";
import { projectScopeId, resolveScope, syncProjectScope, scopeHint } from "../project-scope.ts";
import { recordSessionIdentity } from "../session-identity.ts";

interface RecallInput {
  cwd?: string;
  session_id?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;


// Injected once at session start so the model actively queries memory through
// the Honcho MCP tools rather than leaning on heavy per-turn injection.
const TOOL_HINT =
  "Honcho memory tools are available via MCP — call honcho search / get_peer_context to recall facts " +
  "across sessions, and honcho chat for questions about the user's history. Prefer querying over guessing.";

// SessionStart: materialize the session and surface a lean snapshot of what we
// know, plus a nudge to use the MCP tools for anything deeper.
export async function recall(input: RecallInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd, input.session_id);
  const key = memoryKey(config, cwd, input.session_id);
  if (config.saveMessages) recordSessionIdentity(config, cwd, input.session_id);

  const project = await resolveScope(config, input.session_id);
  // Never fall back to global recall after a failed desktop lookup.
  if (project.status === "unknown") {
    writeContext(key, null, null);
    return scopeHint(project);
  }

  // Create + materialize the session once, here at SessionStart.
  if (config.saveMessages) await createSession(config, name);

  if (config.saveMessages && project.status !== "disabled") await syncProjectScope(config, name, project);
  const boundary = project.status === "project" ? projectScopeId(project) : project.status;
  let ctx = !isStale(key, CACHE_TTL_MS) ? readContext(key) : null;
  if (!ctx || ctx.boundary !== boundary) {
    const fetched = await recallContext(config, project.status === "project" ? projectScopeId(project) : undefined);
    writeContext(key, fetched.representation, fetched.peerCard, boundary);
    ctx = { representation: fetched.representation, peerCard: fetched.peerCard, at: Date.now() };
  }

  const block = renderContext(ctx, config.peerName, 5);
  if (block) markInjected(key, block);

  // Codex surfaces SessionStart hook output to the user, so we append a deep
  // link to this session in the Honcho GUI (parity with the Claude Code
  // integration). We have the live session_id here, so the link is exact for
  // every strategy — including chat-instance.
  const link = `View this session in Honcho: ${honchoSessionUrl(config.workspace, name)}`;

  const parts = [block, scopeHint(project), TOOL_HINT, link].filter(Boolean);
  return parts.join("\n");
}
