export const FAST_MODES = ["off", "on", "force"];

export function resolveFastMode({ fastMode, allowFastMode }) {
  if (fastMode != null) {
    if (!FAST_MODES.includes(fastMode)) throw new Error("fastMode must be off, on, or force");
    return fastMode;
  }
  return allowFastMode === true || allowFastMode === 1 ? "on" : "off";
}
