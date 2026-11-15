import { loadConfig, sessionName, memoryKey, honchoSessionUrl } from "../config.ts";
import { createSession } from "../memory.ts";
import { resetTaskInjection } from "../task-cache.ts";
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
export async function recall(input: RecallInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";
  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd, input.session_id);
  resetTaskInjection(config, memoryKey(config, cwd, input.session_id));
  if (config.saveMessages) recordSessionIdentity(config, cwd, input.session_id);
  try {
    await createSession(config, name);
  } catch {
    // Tool access remains useful during an API outage; writeback can retry.
  }
  return `${TOOL_HINT}\nView this session in Honcho: ${honchoSessionUrl(config.workspace, name)}`;
}
