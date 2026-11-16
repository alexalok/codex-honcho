import { test, expect } from "bun:test";
import { recallContext } from "../src/recall-context.ts";
import type { Config } from "../src/config.ts";

test("scoped recall sends scope and excludes global card; reads never provision resources", async () => {
  const requests: { method: string; path: string; body: any }[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    requests.push({ method: req.method, path: new URL(req.url).pathname, body: req.method === "POST" ? await req.json() : null });
    return Response.json({ representation: "Scoped fact", peer_card: ["GLOBAL CARD"] });
  }});
  const config = { apiKey: "test", workspace: "test", peerName: "alex", endpoint: { baseUrl: `http://127.0.0.1:${server.port}` } } as Config;
  try {
    expect(await recallContext(config, "project-scope")).toEqual({ representation: "Scoped fact", peerCard: null });
    expect(requests).toEqual([{ method: "POST", path: "/v3/workspaces/test/peers/alex/representation", body: { scope: "project-scope", max_conclusions: 8, include_most_frequent: true } }]);
    expect((await recallContext(config)).peerCard).toEqual(["GLOBAL CARD"]);
    expect(requests[1].method).toBe("GET");
    expect(requests[1].path).toEndWith("/context");
  } finally { server.stop(true); }
});
