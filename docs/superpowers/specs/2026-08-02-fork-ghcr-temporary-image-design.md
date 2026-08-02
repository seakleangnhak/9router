# Fork GHCR Temporary Image Design

## Goal

Publish the GPT-5.6 Codex override branch as a temporary public Docker image from the `seakleangnhak/9router` fork while upstream PR #2988 is awaiting merge and release.

## Approach

Use a dedicated fork-only branch based on feature commit `62247ef`. Add a GitHub Actions workflow to that branch and trigger it with the branch push. This keeps the temporary publishing machinery out of upstream PR #2988 and avoids changing the fork's default branch.

The workflow publishes only to GitHub Container Registry. It does not log in to Docker Hub or use repository secrets beyond the workflow-provided `GITHUB_TOKEN` with `packages: write` permission.

## Image Output

The workflow builds the repository Dockerfile for both `linux/amd64` and `linux/arm64` and publishes:

- `ghcr.io/seakleangnhak/9router:gpt-5.6-overrides` as the moving temporary deployment tag.
- `ghcr.io/seakleangnhak/9router:62247ef` as the immutable feature-commit tag.

Both tags must resolve to the same multi-platform manifest. The package must be public so deployment hosts can pull without registry authentication.

## Workflow Behavior

The workflow runs when `codex/gpt-5-6-temp-image` is pushed. GitHub only reliably dispatches manual workflows that exist on the default branch, so this fork-only workflow deliberately uses the branch push as its trigger. Concurrency cancels an older in-progress build for the same branch. BuildKit registry caching uses a dedicated GHCR build-cache tag.

The immutable tag is derived from the feature commit being packaged, not from the workflow-only commit, so it identifies the application code in upstream PR #2988.

## Verification

Before pushing, validate the workflow YAML and inspect the resolved tags and permissions. After pushing:

1. Wait for the GitHub Actions run to complete successfully.
2. Set the GHCR package visibility to public if GitHub created it as private.
3. Verify anonymous registry access.
4. Inspect both tags and confirm they expose `linux/amd64` and `linux/arm64` manifests.

## Lifecycle

Keep the fork-only branch and temporary tags available for deployment and PR feedback. Once upstream ships an official image containing PR #2988, deployments can switch back to the official tag and the temporary branch/package tags can be removed separately.
