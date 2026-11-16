import { Honcho } from "@honcho-ai/sdk";
import { honchoClientOptions, type Config } from "./config.ts";

// Use the SDK's public HTTP client for reads without provisioning peers/sessions.
// peer.context() has no scope option; never combine a scoped representation with
// a global peer card.
export async function recallContext(config: Config, scope: string, query: string) {
  const http = new Honcho({ ...honchoClientOptions(config), timeout: 4000, maxRetries: 0 }).http;
  const path = `/v3/workspaces/${encodeURIComponent(config.workspace)}/peers/${encodeURIComponent(config.peerName)}`;
  const options = { max_conclusions: 6, include_most_frequent: false, search_query: query, search_top_k: 6, search_max_distance: 0.5 };
  const result = await http.post<{ representation: string }>(`${path}/representation`, { body: { ...options, scope } });
  return { representation: result.representation, peerCard: null };
}
