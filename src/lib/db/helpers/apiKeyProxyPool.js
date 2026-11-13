import { getProxyPoolById } from "../repos/proxyPoolsRepo.js";

export async function validateApiKeyProxyPool(proxyPoolId) {
  if (proxyPoolId === undefined || proxyPoolId === null) return null;
  if (typeof proxyPoolId !== "string" || !proxyPoolId.trim()) {
    return "proxyPoolId must be a non-empty string or null";
  }
  const pool = await getProxyPoolById(proxyPoolId);
  if (!pool?.isActive || typeof pool.proxyUrl !== "string" || !pool.proxyUrl.trim()) {
    return "Proxy pool must exist, be active, and have a proxy URL";
  }
  try {
    const value = pool.proxyUrl.trim();
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported proxy protocol");
  } catch {
    return "API key proxy pools require a valid HTTP or HTTPS URL";
  }
  return null;
}
