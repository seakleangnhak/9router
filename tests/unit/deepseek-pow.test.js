import { describe, expect, it } from "vitest";
import { findDeepSeekPowNonce } from "../../open-sse/lib/deepseek-pow-hash.js";

describe("DeepSeek PoW hash compatibility", () => {
  // Vectors from the prior independent BigInt deepSeekHashV1Reference.
  it.each([
    ["", 0, "5f6176ce62563cb9559e52639ff73c0bd001bc731e6d1b9e9c2776bbb802b7a0"],
    ["salt_1700000000_", 7, "5013d0ba33b12e18f572058fd0c9bf8d0b8e1d036f9e03c340672f511630b23a"],
    ["x".repeat(134), 0, "b1caf71c5b6870b038050fd8cffcef17d81b299b28e20ae40db2334f708d8dad"],
    ["x".repeat(135), 0, "a3921c292ebec8a9d8b0f86523b89178efd371873ac409f8e2a385a9075b7436"],
    ["x".repeat(136), 0, "145d7dc01fe307a95abb7359fda3314e8a10c5a06cf18e1ff97b35a4e70c5433"],
    ["x".repeat(270), 10, "85373f41a7fa327c093ca9b587db166cb608abaf76a2480c0b108d7d14f81600"],
    ["ខ្មែរ_", 12, "daa6cc75372d30711a5815d2a7dd99c39a24b7450816df51a6e5d6a0ff9d180b"],
  ])("finds nonce for prefix %s", (prefix, nonce, challenge) => {
    expect(findDeepSeekPowNonce(prefix, challenge, nonce + 1)).toBe(nonce);
    expect(findDeepSeekPowNonce(prefix, challenge, nonce)).toBe(-1);
  });
});
