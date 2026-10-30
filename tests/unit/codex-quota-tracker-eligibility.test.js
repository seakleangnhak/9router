import { expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => [
    { id: "oauth", provider: "codex", authType: "oauth", accessToken: "secret-oauth", refreshToken: "secret-refresh" },
    { id: "token", provider: "codex", authType: "access_token", accessToken: "secret-token" },
    { id: "wrong", provider: "codex", authType: "apikey", apiKey: "secret-key" },
  ],
}));
vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: async () => {} }));
import { GET } from "@/app/api/providers/client/route.js";

it("lists OAuth and access-token Codex accounts without exposing credentials", async () => {
  const response = await GET(new Request("http://localhost/api/providers/client?provider=codex"));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.connections.map((connection) => connection.id).sort()).toEqual(["oauth", "token"]);
  expect(JSON.stringify(result)).not.toContain("secret-");
});
