import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSettings } = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:8787" }));

const { GET } = await import("../../src/app/api/headroom/proxy/[...path]/route.js");

function request(path, headers) {
  return new Request(`https://airouter.kesspay.io/api/headroom/proxy/${path}`, { headers });
}

describe("Headroom dashboard proxy", () => {
  beforeEach(() => {
    getSettings.mockResolvedValue({ headroomUrl: "http://headroom:8787" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      headers: { "content-type": "application/json" },
    })));
  });

  it.each(["dashboard", "dashboard/settings"])("rewrites assets, navigation, and API paths in %s", async (path) => {
    const html = `<script src="/dashboard/static/alpine.min.js"></script>
      <a href="/dashboard/settings">Settings</a>
      this.fetchJson('/stats?cached=1'); this.fetchJson('/health');
      this.fetchJson('/stats-history'); this.fetchJson('/transformations/feed?limit=50');
      fetch('/stats-lifetime'); fetch('/settings'); fetch('/settings/schema'); fetch('/settings/apply');
      fetch('/stats-history' + query); fetch(\`/health\`);
      <script src="https://cdn.example.com/app.js"></script><a href="//example.com">External</a>`;
    fetch.mockResolvedValue(new Response(html, {
      headers: { "content-type": "text/html", "content-length": "123", "content-encoding": "gzip" },
    }));

    const response = await GET(request(path), { params: Promise.resolve({ path: path.split("/") }) });
    const body = await response.text();

    for (const endpoint of ["dashboard/static/alpine.min.js", "dashboard/settings", "stats?cached=1", "health", "stats-history", "transformations/feed?limit=50", "stats-lifetime", "settings", "settings/schema", "settings/apply"]) {
      expect(body).toContain(`/api/headroom/proxy/${endpoint}`);
    }
    expect(body).toContain("https://cdn.example.com/app.js");
    expect(body).toContain('href="//example.com"');
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.has("content-encoding")).toBe(false);
  });

  it.each(["http://headroom:8787", "http://127.0.0.1:8787"])("does not forward viewer credentials or peer proof to %s", async (headroomUrl) => {
    getSettings.mockResolvedValue({ headroomUrl });
    const response = await GET(request("stats?cached=1", {
      host: "airouter.kesspay.io",
      authorization: "Bearer viewer-token",
      cookie: "auth_token=dashboard-session",
      connection: "keep-alive",
      "x-9r-cli-token": "cli-secret",
      "x-9r-peer-token": "peer-secret",
      "x-9r-real-ip": "203.0.113.10",
      "x-9r-via-proxy": "1",
      accept: "application/json",
    }), { params: Promise.resolve({ path: ["stats"] }) });
    const [target, options] = fetch.mock.calls[0];

    expect(response.status).toBe(200);
    expect(target.href).toBe(`${headroomUrl}/stats?cached=1`);
    expect(options.redirect).toBe("manual");
    expect([...options.headers]).toEqual([["accept", "application/json"]]);
  });

  it("keeps dashboard assets unmodified", async () => {
    const script = "fetch('/health')";
    fetch.mockResolvedValue(new Response(script, { headers: { "content-type": "text/javascript" } }));

    const response = await GET(request("dashboard/static/alpine.min.js"), {
      params: Promise.resolve({ path: ["dashboard", "static", "alpine.min.js"] }),
    });

    expect(await response.text()).toBe(script);
  });
});
