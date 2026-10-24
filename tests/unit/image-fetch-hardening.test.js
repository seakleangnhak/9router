import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock DNS lookup so we control which host resolves to what IP.
const lookupMock = vi.fn();
// image.js resolves with { all: true } (DNS pinning, c7d07448), which returns an array;
// a bare record made every lookup fail, so private-IP cases passed for the wrong reason.
vi.mock("node:dns/promises", () => ({
  lookup: async (host, opts) => {
    const record = await lookupMock(host, opts);
    return opts?.all ? [record] : record;
  },
}));
vi.mock("../../open-sse/executors/base.js", () => ({ BaseExecutor: class {} }));

import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";
import { resolveImageBytes } from "../../open-sse/executors/uc-web.js";
import { resolveImageRef } from "../../open-sse/executors/muse-web.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mockFetchOnce(bytes, ok = true) {
  const body = {
    getReader() {
      let sent = false;
      return {
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(bytes) }),
        cancel: async () => {},
      };
    },
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, body })));
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue({ address: "93.184.216.34" }); // public by default
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// The SSRF cases mock a fetch that would succeed, so a null result can only come from
// the guard, and assert the request is never sent.
describe("fetchImageAsBase64 hardening", () => {
  it("rejects non-http url", async () => {
    expect(await fetchImageAsBase64("ftp://x/y.png")).toBeNull();
    expect(await fetchImageAsBase64("data:image/png;base64,xx")).toBeNull();
  });

  it("SSRF: rejects private IP (10.x)", async () => {
    lookupMock.mockResolvedValue({ address: "10.0.0.5" });
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("http://internal.example/x.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("SSRF: rejects cloud metadata 169.254.169.254", async () => {
    lookupMock.mockResolvedValue({ address: "169.254.169.254" });
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("http://metadata/x.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("SSRF: rejects blocked hostname localhost", async () => {
    expect(await fetchImageAsBase64("http://localhost/x.png")).toBeNull();
  });

  it("SSRF: rejects IPv6 loopback", async () => {
    lookupMock.mockResolvedValue({ address: "::1" });
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("http://x/y.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("accepts valid PNG from public host", async () => {
    mockFetchOnce(PNG);
    const r = await fetchImageAsBase64("https://example.com/a.png");
    expect(r).not.toBeNull();
    expect(r.mimeType).toBe("image/png");
    expect(r.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects disguised non-image payload (magic byte mismatch)", async () => {
    mockFetchOnce(Buffer.from("<?php system($_GET[c]); ?>"));
    expect(await fetchImageAsBase64("https://example.com/evil.png")).toBeNull();
  });

  it("rejects payload over size cap", async () => {
    mockFetchOnce(Buffer.alloc(1024));
    expect(await fetchImageAsBase64("https://example.com/big.png", { maxBytes: 100 })).toBeNull();
  });

  it("returns null when fetch not ok", async () => {
    mockFetchOnce(PNG, false);
    expect(await fetchImageAsBase64("https://example.com/404.png")).toBeNull();
  });
});

describe("web executor input images", () => {
  it.each(["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1"])("rejects %s before fetch", async (address) => {
    lookupMock.mockResolvedValue({ address });
    mockFetchOnce(PNG);
    const url = "http://input.example/image.png";
    await expect(resolveImageBytes(url)).rejects.toThrow("input image download failed");
    expect(await resolveImageRef(url)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves public image bytes and MIME through the protected fetch", async () => {
    mockFetchOnce(PNG);
    const signal = new AbortController().signal;
    expect(await resolveImageBytes("HTTPS://input.example/image.png", signal)).toEqual(PNG);
    expect(await resolveImageRef("https://input.example/image.png")).toEqual({
      b64: PNG.toString("base64"), mime: "image/png",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, "https://input.example/image.png", expect.objectContaining({
      signal, redirect: "manual", dispatcher: expect.anything(),
    }));
  });

  it("preserves inline images without DNS or HTTP requests", async () => {
    mockFetchOnce(PNG);
    const b64 = PNG.toString("base64");
    const dataUri = `data:image/png;base64,${b64}`;
    expect(await resolveImageBytes(dataUri)).toEqual(PNG);
    expect(await resolveImageBytes(b64)).toEqual(PNG);
    expect(await resolveImageRef(dataUri)).toEqual({ b64, mime: "image/png" });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects remote non-image bytes", async () => {
    mockFetchOnce(Buffer.from("not an image"));
    await expect(resolveImageBytes("https://input.example/image.png")).rejects.toThrow("input image download failed");
    expect(await resolveImageRef("https://input.example/image.png")).toBeNull();
  });
});
