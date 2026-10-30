import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  getProviderConnectionById: vi.fn(),
  getCodexAutoReset: vi.fn(),
  updateCodexAutoReset: vi.fn(),
  configureCodexAutoReset: vi.fn(),
}));
vi.mock("@/dashboardGuard", () => ({ isAuthenticated: mocks.isAuthenticated }));
vi.mock("@/lib/db/index.js", () => ({ getProviderConnectionById: mocks.getProviderConnectionById }));
vi.mock("@/lib/db/repos/codexResetRepo.js", () => ({
  getCodexAutoReset: mocks.getCodexAutoReset, updateCodexAutoReset: mocks.updateCodexAutoReset,
}));
vi.mock("@/shared/services/codexAutoReset.js", () => ({
  configureCodexAutoReset: mocks.configureCodexAutoReset,
  codexResetAccountKey: (connection) => connection.providerSpecificData?.chatgptAccountId || null,
  codexAutoResetStatus: ({ mode, reason }) => ({ mode, reason }),
}));
import { GET, PATCH } from "@/app/api/usage/[connectionId]/codex-auto-reset/route.js";

const params = { params: Promise.resolve({ connectionId: "codex-1" }) };
function request(body, origin = "http://localhost") {
  return new Request("http://localhost/api/usage/codex-1/codex-auto-reset", {
    method: "PATCH", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
  });
}

describe("Codex auto-reset settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getProviderConnectionById.mockResolvedValue({ provider: "codex", authType: "oauth" });
    mocks.getCodexAutoReset.mockResolvedValue({ mode: "off", reason: "Disabled", pending: { token: "private" } });
    mocks.updateCodexAutoReset.mockImplementation(async (_id, patch) => patch);
  });

  it("requires dashboard authentication for reads and changes", async () => {
    mocks.isAuthenticated.mockResolvedValue(false);
    expect((await GET(request({}), params)).status).toBe(401);
    expect((await PATCH(request({ mode: "smart", acknowledged: true }), params)).status).toBe(401);
    expect(mocks.updateCodexAutoReset).not.toHaveBeenCalled();
  });

  it("rejects cross-origin changes", async () => {
    expect((await PATCH(request({ mode: "smart", acknowledged: true }, "https://other.example"), params)).status).toBe(403);
    expect(mocks.updateCodexAutoReset).not.toHaveBeenCalled();
  });

  it("accepts configured public origin behind a reverse proxy", async () => {
    vi.stubEnv("BASE_URL", "https://airouter.example.test");
    try {
      expect((await PATCH(request({ mode: "auto", acknowledged: true }, "https://airouter.example.test"), params)).status).toBe(200);
    } finally { vi.unstubAllEnvs(); }
  });

  it("returns status without internal redemption state", async () => {
    const response = await GET(request({}), params);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ mode: "off", reason: "Disabled" });
  });

  it.each(["auto", "smart"])("requires spending acknowledgment for %s", async (mode) => {
    expect((await PATCH(request({ mode }), params)).status).toBe(400);
    expect(mocks.updateCodexAutoReset).not.toHaveBeenCalled();
    expect((await PATCH(request({ mode, acknowledged: true }), params)).status).toBe(200);
    expect(mocks.configureCodexAutoReset).toHaveBeenCalledOnce();
  });

  it("accepts Off without acknowledgment and does not mass-assign client state", async () => {
    const response = await PATCH(request({ mode: "off", pending: { redeemRequestId: "attacker" }, lastResetAt: "fake" }), params);
    expect(response.status).toBe(200);
    expect(mocks.updateCodexAutoReset).toHaveBeenCalledWith("codex-1", {
      mode: "off", accountKey: null, reason: "Automatic reset disabled.", expiresAt: null,
    });
  });

  it.each([null, {}, { mode: "on" }, { mode: [] }])("rejects invalid settings %j", async (body) => {
    expect((await PATCH(request(body), params)).status).toBe(400);
    expect(mocks.updateCodexAutoReset).not.toHaveBeenCalled();
  });

  it("rejects non-Codex accounts", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ provider: "openai", authType: "apikey" });
    expect((await PATCH(request({ mode: "smart", acknowledged: true }), params)).status).toBe(404);
  });

  it("returns to Off if scheduler configuration fails after saving an enabled mode", async () => {
    mocks.configureCodexAutoReset.mockRejectedValueOnce(new Error("fixture database failure"));
    expect((await PATCH(request({ mode: "smart", acknowledged: true }), params)).status).toBe(503);
    expect(mocks.updateCodexAutoReset).toHaveBeenLastCalledWith("codex-1", {
      mode: "off", reason: "Configuration failed; automatic resets disabled.",
    });
  });
});
