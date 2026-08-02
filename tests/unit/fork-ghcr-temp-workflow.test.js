import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/fork-ghcr-temp.yml", import.meta.url)
);

describe("fork GHCR temporary image workflow", () => {
  it("publishes the approved image tags without Docker Hub", () => {
    expect(existsSync(workflowPath), "temporary image workflow must exist").toBe(true);

    const workflow = load(readFileSync(workflowPath, "utf8"));
    expect(workflow.on.push.branches).toContain("codex/gpt-5-6-temp-image");
    expect(workflow.permissions).toEqual({ contents: "read", packages: "write" });
    expect(workflow.env).toMatchObject({
      GHCR_IMAGE: "ghcr.io/${{ github.repository }}",
      FEATURE_COMMIT: "62247ef2cbadc0f30d9946d0d260d14f60ef88e0",
      FEATURE_TAG: "62247ef",
    });

    const serialized = JSON.stringify(workflow);
    expect(serialized).toContain("linux/amd64,linux/arm64");
    expect(serialized).toContain("${{ env.GHCR_IMAGE }}:gpt-5.6-overrides");
    expect(serialized).toContain("${{ env.GHCR_IMAGE }}:${{ env.FEATURE_TAG }}");
    expect(serialized).not.toMatch(/dockerhub|decolua\/9router/i);
  });
});
