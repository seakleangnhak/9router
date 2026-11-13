import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { extractClientApiKey } from "./keyAccess.js";
import { errorResponse } from "open-sse/utils/error.js";

const requestContexts = new WeakMap();

async function resolveKeyProxyContext(request) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return {};
  const key = await getApiKeyByKey(apiKey);
  if (!key?.isActive || key.proxyPoolId == null) return {};

  const proxy = await resolveConnectionProxyConfig({ proxyPoolId: key.proxyPoolId });
  let proxyUrl;
  try {
    const value = proxy.vercelRelayUrl || proxy.connectionProxyUrl;
    proxyUrl = new URL(value.includes("://") ? value : `http://${value}`);
    if (!["http:", "https:"].includes(proxyUrl.protocol)) throw new Error("Unsupported proxy protocol");
  } catch {
    return { error: errorResponse(503, "API key proxy pool is unavailable") };
  }
  if (!proxy.proxyPool || proxy.source === "error" ||
      (!proxy.connectionProxyUrl && !proxy.vercelRelayUrl)) {
    return { error: errorResponse(503, "API key proxy pool is unavailable") };
  }

  return {
    requestProxyOptions: {
      keyProxy: true,
      proxyPoolId: key.proxyPoolId,
      connectionProxyEnabled: proxy.connectionProxyEnabled,
      connectionProxyUrl: proxy.connectionProxyEnabled ? proxyUrl.href : "",
      connectionNoProxy: "",
      vercelRelayUrl: proxy.vercelRelayUrl ? proxyUrl.href : "",
      strictProxy: true,
    },
  };
}

// Reuse one routing decision across combo members and account retries.
export function getKeyProxyContext(request) {
  if (!request) return Promise.resolve({});
  if (!requestContexts.has(request)) {
    requestContexts.set(request, resolveKeyProxyContext(request));
  }
  return requestContexts.get(request);
}
