const langsearch = {
  id: "langsearch",
  alias: "langsearch",
  display: {
    name: "LangSearch",
    icon: "search",
    color: "#1670ED",
    textIcon: "LS",
    website: "https://langsearch.com",
    notice: {
      apiKeyUrl: "https://langsearch.com/api-keys",
      text: "Free Web Search with shared per-minute and daily token limits. New accounts start at 5 requests/second. Daily allowance resets at 00:00 UTC.",
    },
  },
  category: "apikey",
  authType: "apikey",
  hasFree: true,
  serviceKinds: ["webSearch"],
  searchConfig: {
    baseUrl: "https://api.langsearch.com/v1/web-search",
    method: "POST",
    authType: "apikey",
    authHeader: "bearer",
    costPerQuery: 0,
    searchTypes: ["web"],
    defaultMaxResults: 5,
    maxMaxResults: 50,
    timeoutMs: 10000,
  },
};

export default langsearch;
