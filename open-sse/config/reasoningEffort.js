export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function clampReasoningEffort(body, maxReasoningEffort) {
  const ceiling = REASONING_EFFORTS.indexOf(maxReasoningEffort);
  if (ceiling < 0) return;
  for (const [field, effort] of [["reasoning_effort", body.reasoning_effort], ["reasoning", body.reasoning?.effort], ["output_config", body.output_config?.effort]]) {
    if (typeof effort === "string" && REASONING_EFFORTS.indexOf(effort.toLowerCase()) > ceiling) {
      body[field] = field === "reasoning_effort" ? maxReasoningEffort : { ...body[field], effort: maxReasoningEffort };
    }
  }
}
