// Run against a temporary local server: KEY_PROXY_UI_PASSWORD=... node tests/ui/key-proxy.mjs [URL]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = new URL(process.argv[2] || "http://127.0.0.1:20139");
assert(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Use a temporary localhost server");
assert(process.env.KEY_PROXY_UI_PASSWORD, "Set KEY_PROXY_UI_PASSWORD for the temporary server");
const browser = await chromium.launch({ channel: "chrome" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post(new URL("/api/auth/login", base).href, {
    data: { password: process.env.KEY_PROXY_UI_PASSWORD },
  });
  assert.equal(login.status(), 200, await login.text());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const pools = [
    { id: "pool-a", name: "Proxy Alpha", isActive: true },
    { id: "pool-b", name: "Proxy Beta", isActive: true },
    { id: "pool-off", name: "Paused Proxy", isActive: false },
  ];
  const keys = ["Production", "Paused key", "Tools"].map((name, index) => ({
    id: `key-${index}`, name, key: `sk-fixture-${index}-never-a-real-key`,
    fastMode: "force", isActive: index !== 1, createdAt: "2026-11-13T00:00:00Z",
    proxyPoolId: null, access: { restricted: false, allow: [] },
  }));
  const writes = [];
  let failKey = null;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let json = {};
    if (pathname === "/api/keys") json = { keys };
    else if (pathname.startsWith("/api/keys/") && request.method() === "PUT") {
      const key = keys.find(key => key.id === pathname.split("/").at(-1));
      assert(key, "Unknown fixture key");
      const data = request.postDataJSON();
      writes.push({ id: key.id, ...data });
      if (key.id === failKey) return route.fulfill({ status: 400, json: { error: "Fixture pool unavailable" } });
      Object.assign(key, data);
      json = { key };
    } else if (pathname === "/api/proxy-pools") json = { proxyPools: pools };
    else if (pathname === "/api/settings") json = { requireApiKey: true, requireLogin: true, hasPassword: true };
    else if (pathname === "/api/tunnel/status") json = { tunnel: { enabled: false }, tailscale: { enabled: false } };
    await route.fulfill({ json });
  });
  await page.goto(new URL("/dashboard/endpoint", base).href);
  const select = name => page.getByRole("combobox", { name: `Proxy pool for ${name}`, exact: true });
  await select("Production").waitFor();
  const modal = page.getByRole("heading", { name: "Apply Proxy (3 keys)" });
  const dialog = page.getByRole("dialog", { name: "Apply Proxy (3 keys)" });
  const trigger = page.getByRole("button", { name: /Apply Proxy$/ });
  async function values(expected) {
    await page.waitForFunction(expected => expected.every((value, index) =>
      document.querySelector(`#key-proxy-key-${index}`)?.value === (value || "")), expected);
  }
  async function openBulk() {
    await trigger.click();
    await modal.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "dialog");
    assert(await dialog.evaluate(element => element === document.activeElement), "Bulk dialog must gain focus");
  }
  async function bulk(name, expected) {
    await openBulk();
    await page.getByRole("button", { name }).click();
    await modal.waitFor({ state: "hidden" });
    await values(expected);
  }
  await openBulk();
  await page.keyboard.press("Tab");
  const firstButton = dialog.getByRole("button", { name: /One-to-one \(rotate\)/ });
  assert(await firstButton.evaluate(element => element === document.activeElement), "Tab must reach first enabled dialog button");
  await page.keyboard.press("Shift+Tab");
  assert(await dialog.getByRole("button", { name: "Close", exact: true }).evaluate(element => element === document.activeElement), "Shift+Tab must wrap to last dialog button");
  await page.keyboard.press("Tab");
  assert(await firstButton.evaluate(element => element === document.activeElement), "Tab must wrap to first dialog button");
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert(await trigger.evaluate(element => element === document.activeElement), "Closing dialog must restore trigger focus");
  await select("Production").selectOption("pool-a");
  await values(["pool-a", null, null]);
  assert.deepEqual(writes.at(-1), { id: "key-0", proxyPoolId: "pool-a" });
  await openBulk();
  assert(await page.getByRole("button", { name: /Paused Proxy/ }).isDisabled());
  await page.getByRole("button", { name: /Proxy Beta/ }).click();
  await modal.waitFor({ state: "hidden" });
  await values(["pool-b", "pool-b", "pool-b"]);
  await bulk(/One-to-one \(rotate\)/, ["pool-a", "pool-b", "pool-a"]);
  assert.deepEqual(writes.slice(-3), keys.map((key, index) => ({ id: key.id, proxyPoolId: index % 2 ? "pool-b" : "pool-a" })));
  failKey = "key-1";
  await openBulk();
  await page.getByRole("button", { name: /Proxy Alpha/ }).click();
  await page.getByRole("alert").filter({ hasText: "Updated 2 of 3 keys" }).waitFor();
  assert(await modal.isVisible(), "Partial failure must keep bulk dialog open");
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await values(["pool-a", "pool-b", "pool-a"]);
  await page.getByRole("alert").filter({ hasText: "Fixture pool unavailable" }).waitFor();
  failKey = null;
  await bulk(/Inherit account\/global proxy \(all keys\)/, [null, null, null]);
  assert.equal(await page.getByRole("alert").filter({ hasText: "Fixture pool unavailable" }).count(), 0);
  await mkdir("/tmp/9router-key-proxy-ui", { recursive: true });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await select("Production").scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Page overflow at ${width}px`);
    await select("Production").focus();
    await page.keyboard.press("Tab");
    const fast = page.getByRole("button", { name: /^Fast mode for Production:/ });
    assert(await fast.evaluate(element => element === document.activeElement), `Proxy must precede Fast mode in keyboard order at ${width}px`);
    if (width === 1440) {
      const proxyBox = await select("Production").boundingBox();
      const fastBox = await fast.boundingBox();
      assert(proxyBox.x + proxyBox.width <= fastBox.x, "Proxy must sit before Fast mode");
      assert.equal(proxyBox.height, fastBox.height, "Controls must use matching heights");
    }
    await page.screenshot({ path: `/tmp/9router-key-proxy-ui/${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log("Key proxy UI passed: individual/bulk/rotation/inheritance/partial failure; dialog focus/wrap/Escape; 4 widths; keyboard order; no runtime errors.");
} finally {
  await browser.close();
}
