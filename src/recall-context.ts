import { Honcho } from "@honcho-ai/sdk";
import { honchoClientOptions, type Config } from "./config.ts";

// Use the SDK's public HTTP client for reads without provisioning peers/sessions.
// peer.context() has no scope option; never combine a scoped representation with
// a global peer card.
export async function recallContext(config: Config, scope?: string) {
  const http = new Honcho(honchoClientOptions(config)).http;
  const path = `/v3/workspaces/${encodeURIComponent(config.workspace)}/peers/${encodeURIComponent(config.peerName)}`;
  const options = { max_conclusions: 8, include_most_frequent: true };
  if (scope) {
    const result = await http.post<{ representation: string }>(`${path}/representation`, { body: { ...options, scope } });
    return { representation: result.representation, peerCard: null };
  }
  const result = await http.get<{ representation: string | null; peer_card: string[] | null }>(`${path}/context`, { query: options });
  return { representation: result.representation, peerCard: result.peer_card };
}
