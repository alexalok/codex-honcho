import { loadConfig, sessionName, memoryKey, honchoSessionUrl } from "../config.ts";
import { createSession } from "../memory.ts";
import { resetTaskInjection } from "../task-cache.ts";
import { writeContext } from "../cache.ts";
import { resolveScope, projectScopeId, syncProjectScope, scopeHint } from "../project-scope.ts";
import { recordSessionIdentity } from "../session-identity.ts";

interface RecallInput {
  cwd?: string;
  session_id?: string;
}

const TOOL_HINT =
  "Honcho memory tools are available via MCP. Use honcho search for task-relevant history " +
  "and honcho chat for specific questions about past decisions.";

// SessionStart has no task query: initialize writeback identity and expose
// tools, but never fetch or inject a generic user profile.
export async function recall(input: RecallInput, resolvedProject?: Awaited<ReturnType<typeof resolveScope>>): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";
  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd, input.session_id);
  const key = memoryKey(config, cwd, input.session_id);
  const project = resolvedProject ?? await resolveScope(config, input.session_id);
  if (project.status === "unknown") {
    writeContext(key, null, null);
    return scopeHint(project);
  }
  const boundary = project.status === "project" ? projectScopeId(project) : project.status;
  resetTaskInjection(config, config.scopeStrategy === "desktop-project" ? `${key}:${boundary}` : key);
  writeContext(key, null, null, boundary);
  if (config.saveMessages) recordSessionIdentity(config, cwd, input.session_id);
  try {
    if (config.saveMessages) {
      await createSession(config, name);
      if (project.status !== "disabled") await syncProjectScope(config, name, project);
    }
  } catch {
    // Tool access remains useful during an API outage; writeback can retry.
  }
  return `${scopeHint(project)}\n${TOOL_HINT}\nView this session in Honcho: ${honchoSessionUrl(config.workspace, name)}`;
}
