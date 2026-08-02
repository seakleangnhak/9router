# Fork GHCR Temporary Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the GPT-5.6 Codex override branch as a public, multi-platform temporary image from the `seakleangnhak/9router` fork.

**Architecture:** A fork-only branch contains a push-triggered GitHub Actions workflow that builds the existing Dockerfile and pushes two GHCR tags. A small Vitest file validates the workflow contract before it is pushed; GitHub Actions and anonymous registry inspection verify the actual published artifact.

**Tech Stack:** GitHub Actions, Docker Buildx, GitHub Container Registry, Vitest, js-yaml, GitHub CLI

## Global Constraints

- Keep upstream PR #2988 and branch `codex/gpt-5-6-reasoning-overrides` unchanged.
- Publish only to `ghcr.io/seakleangnhak/9router`; do not authenticate to or push to Docker Hub.
- Build `linux/amd64` and `linux/arm64` images.
- Publish moving tag `gpt-5.6-overrides` and immutable application tag `62247ef`.
- Make the resulting GHCR package public.
- Use only `GITHUB_TOKEN` inside GitHub Actions, with `contents: read` and `packages: write` permissions.

---

### Task 1: Add and validate the fork-only GHCR workflow

**Files:**
- Create: `.github/workflows/fork-ghcr-temp.yml`
- Create: `tests/unit/fork-ghcr-temp-workflow.test.js`

**Interfaces:**
- Consumes: repository `Dockerfile`, GitHub Actions `GITHUB_TOKEN`, feature application commit `62247ef2cbadc0f30d9946d0d260d14f60ef88e0`
- Produces: push-triggered workflow that publishes `ghcr.io/seakleangnhak/9router:gpt-5.6-overrides` and `ghcr.io/seakleangnhak/9router:62247ef`

- [ ] **Step 1: Write the failing workflow contract test**

```js
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";

const workflowText = readFileSync(
  new URL("../../.github/workflows/fork-ghcr-temp.yml", import.meta.url),
  "utf8"
);
const workflow = load(workflowText);

describe("fork GHCR temporary image workflow", () => {
  it("publishes the approved public-image inputs without Docker Hub", () => {
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
```

- [ ] **Step 2: Run the test to verify it fails because the workflow is absent**

Run:

```bash
./tests/node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/fork-ghcr-temp-workflow.test.js
```

Expected: FAIL with `ENOENT` for `.github/workflows/fork-ghcr-temp.yml`.

- [ ] **Step 3: Create the minimal GHCR-only workflow**

```yaml
name: Build Temporary GPT-5.6 Image

on:
  push:
    branches:
      - codex/gpt-5-6-temp-image

permissions:
  contents: read
  packages: write

concurrency:
  group: fork-ghcr-temp-${{ github.ref }}
  cancel-in-progress: true

env:
  GHCR_IMAGE: ghcr.io/${{ github.repository }}
  FEATURE_COMMIT: 62247ef2cbadc0f30d9946d0d260d14f60ef88e0
  FEATURE_TAG: 62247ef

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          tags: |
            ${{ env.GHCR_IMAGE }}:gpt-5.6-overrides
            ${{ env.GHCR_IMAGE }}:${{ env.FEATURE_TAG }}
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ env.FEATURE_COMMIT }}
          cache-from: type=registry,ref=${{ env.GHCR_IMAGE }}:gpt-5.6-overrides-buildcache
          cache-to: type=registry,ref=${{ env.GHCR_IMAGE }}:gpt-5.6-overrides-buildcache,mode=max
          provenance: false
          sbom: false
```

- [ ] **Step 4: Run the contract test and YAML parser to verify the workflow**

Run:

```bash
./tests/node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/fork-ghcr-temp-workflow.test.js
node -e 'const fs=require("node:fs"); const yaml=require("js-yaml"); yaml.load(fs.readFileSync(".github/workflows/fork-ghcr-temp.yml", "utf8")); console.log("workflow yaml: valid")'
git diff --check
```

Expected: one Vitest file passes, YAML prints `workflow yaml: valid`, and `git diff --check` exits 0.

- [ ] **Step 5: Commit the workflow and its test**

```bash
git add .github/workflows/fork-ghcr-temp.yml tests/unit/fork-ghcr-temp-workflow.test.js
git commit -m "ci: publish temporary GPT-5.6 image"
```

### Task 2: Publish and verify the public image

**Files:**
- No repository file changes.

**Interfaces:**
- Consumes: branch `codex/gpt-5-6-temp-image`, workflow `fork-ghcr-temp.yml`, GitHub Actions run ID, GHCR package `seakleangnhak/9router`
- Produces: public multi-platform manifests for tags `gpt-5.6-overrides` and `62247ef`

- [ ] **Step 1: Push the fork-only branch and capture the push-triggered run**

Run:

```bash
git push -u origin codex/gpt-5-6-temp-image
gh run list --repo seakleangnhak/9router --branch codex/gpt-5-6-temp-image --event push --limit 1
```

Expected: a `Build Temporary GPT-5.6 Image` run appears for the pushed branch.

- [ ] **Step 2: Wait for the GitHub Actions build**

Run:

```bash
image_run_id=$(gh run list --repo seakleangnhak/9router --branch codex/gpt-5-6-temp-image --event push --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$image_run_id" --repo seakleangnhak/9router --exit-status
```

Expected: the `build-and-push` job completes successfully.

- [ ] **Step 3: Set the package visibility to public**

Run:

```bash
gh api --method PATCH /user/packages/container/9router -f visibility=public
gh api /user/packages/container/9router --jq '{name, visibility, html_url}'
```

Expected: package visibility is `public`.

- [ ] **Step 4: Verify both multi-platform manifests**

Run:

```bash
docker buildx imagetools inspect ghcr.io/seakleangnhak/9router:gpt-5.6-overrides
docker buildx imagetools inspect ghcr.io/seakleangnhak/9router:62247ef
```

Expected: both commands succeed and list `linux/amd64` and `linux/arm64` manifests.

- [ ] **Step 5: Verify anonymous public access and branch integrity**

Run:

```bash
gh api /users/seakleangnhak/packages/container/9router --jq '{name, visibility, html_url}'
git status --short --branch
git rev-parse codex/gpt-5-6-reasoning-overrides
git rev-parse origin/codex/gpt-5-6-reasoning-overrides
```

Then verify anonymous registry access without GitHub CLI or Docker credentials:

```bash
node --input-type=module -e '
const image = "seakleangnhak/9router";
const tokenResponse = await fetch(`https://ghcr.io/token?scope=repository:${image}:pull`);
if (!tokenResponse.ok) throw new Error(`anonymous token failed: ${tokenResponse.status}`);
const { token } = await tokenResponse.json();
for (const tag of ["gpt-5.6-overrides", "62247ef"]) {
  const response = await fetch(`https://ghcr.io/v2/${image}/manifests/${tag}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
    },
  });
  if (!response.ok) throw new Error(`${tag} manifest failed: ${response.status}`);
  const manifest = await response.json();
  const platforms = new Set((manifest.manifests || []).map((entry) => `${entry.platform?.os}/${entry.platform?.architecture}`));
  if (!platforms.has("linux/amd64") || !platforms.has("linux/arm64")) throw new Error(`${tag} is missing a required platform`);
  console.log(`${tag}: public linux/amd64 linux/arm64`);
}
'
```

Expected: the public package endpoint reports `public`, both anonymous manifest requests print the required platforms, the image branch is clean, and the local and remote upstream-PR branch refs remain at `62247ef2cbadc0f30d9946d0d260d14f60ef88e0`.
