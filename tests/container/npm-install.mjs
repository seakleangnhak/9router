// Run inside the built image: node /checks/npm-install.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "9router-npm-smoke-"));
const fixture = join(scratch, "fixture");
const project = join(scratch, "project");
const env = {
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  HOME: join(scratch, "home"),
  TMPDIR: scratch,
  NPM_CONFIG_CACHE: join(scratch, "cache"),
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
};
const npm = (args) => execFileSync("npm", args, {
  cwd: scratch, env, timeout: 30000, encoding: "utf8",
});

try {
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    name: "9router-runtime-smoke", version: "1.0.0", main: "index.js",
  }));
  writeFileSync(join(fixture, "index.js"), "module.exports = 42;\n");
  npm(["pack", fixture, "--offline", "--ignore-scripts", "--pack-destination", scratch]);
  npm([
    "install", join(scratch, "9router-runtime-smoke-1.0.0.tgz"),
    "--prefix", project, "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
  ]);
  const require = createRequire(join(project, "package.json"));
  assert.equal(require("9router-runtime-smoke"), 42);
  console.log(`npm ${npm(["--version"]).trim()}: offline package installation passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
