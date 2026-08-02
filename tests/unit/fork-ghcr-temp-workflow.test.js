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
    expect(workflow.on.push.branches).toEqual(["codex/gpt-5-6-temp-image"]);
    expect(workflow.permissions).toEqual({ contents: "read", packages: "write" });
    expect(workflow.env).toEqual({
      GHCR_IMAGE: "ghcr.io/${{ github.repository }}",
      FEATURE_COMMIT: "62247ef2cbadc0f30d9946d0d260d14f60ef88e0",
      FEATURE_TAG: "62247ef",
    });

    expect(Object.keys(workflow.jobs)).toEqual(["build-and-push"]);
    const steps = workflow.jobs["build-and-push"].steps;
    const loginSteps = steps.filter((step) => step.uses?.startsWith("docker/login-action@"));
    expect(loginSteps).toHaveLength(1);
    expect(loginSteps[0].with).toEqual({
      registry: "ghcr.io",
      username: "${{ github.actor }}",
      password: "${{ secrets.GITHUB_TOKEN }}",
    });

    const buildSteps = steps.filter((step) => step.uses?.startsWith("docker/build-push-action@"));
    expect(buildSteps).toHaveLength(1);
    expect(buildSteps[0].with.push).toBe(true);
    expect(buildSteps[0].with.platforms).toBe("linux/amd64,linux/arm64");
    expect(buildSteps[0].with.tags.trim().split("\n")).toEqual([
      "${{ env.GHCR_IMAGE }}:gpt-5.6-overrides",
      "${{ env.GHCR_IMAGE }}:${{ env.FEATURE_TAG }}",
    ]);
  });
});
