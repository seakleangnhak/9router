# Fork GHCR release and rollback

The fork workflow runs `./scripts/test-fork-routing.sh` before either architecture build. Only `codex/gpt-6-1-sol-ghcr` can build and publish, including on manual dispatch. Reproduce the gate with Node `22.23.4`, `npm ci`, and `npm ci --prefix tests`. Docker builds use the same root lockfile. Each architecture retains its build tag, but its runtime security check and final publication use the build's digest. Digest artifacts are uploaded only after that check passes.

## Verify prior known-good image

This digest identifies the previously known-good multi-platform index, not a guarantee that the image is safe for every deployment:

```sh
IMAGE=ghcr.io/seakleangnhak/9router
DIGEST=sha256:9705593e029ee3d1964b8a18c4b52041e44c833e7795b917b0b5e4f4051c6f41
docker buildx imagetools inspect "$IMAGE@$DIGEST"
```

Confirm the returned index digest matches and contains the required `linux/amd64` and `linux/arm64` manifests. Verify provenance and runtime behavior against your own deployment requirements; digest identity alone does not establish either.

The pinned image was smoke-tested locally with no network and a copy of a SQLite fixture created by the upgraded app. It started and returned the saved provider configuration. This does not verify your production database; back it up before a release.

## Roll back by digest

After verifying the image and obtaining deployment approval, set the deployment image to `ghcr.io/seakleangnhak/9router@sha256:9705593e029ee3d1964b8a18c4b52041e44c833e7795b917b0b5e4f4051c6f41` and apply using the deployment's normal procedure. Confirm the running image digest and health afterward. Do not rely on mutable tags such as `latest` for rollback; retain the prior deployment configuration and data backups.
