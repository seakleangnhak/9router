const TIERS = new Set(["default", "auto", "flex", "scale", "fast", "priority", "ultrafast"]);

export const normalizeServiceTier = (tier) => TIERS.has(tier) ? tier : null;
// `auto` is a selection policy, not a processed tier.
export const normalizeReportedServiceTier = (tier) => tier === "auto" ? null : normalizeServiceTier(tier);
