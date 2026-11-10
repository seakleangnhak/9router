import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmRoot = "/usr/local/lib/node_modules/npm";
const npmRequire = createRequire(join(npmRoot, "package.json"));
const semver = npmRequire("semver");
const versions = {};
for (const [name, minimum] of Object.entries({ "ip-address": "10.7.4", undici: "6.29.1", glob: "14.0.2", minimatch: "11.0.1" })) {
  versions[name] = npmRequire(`${name}/package.json`).version;
  assert(semver.gte(versions[name], minimum), `${name} ${versions[name]} is below ${minimum}`);
}
assert.equal(createRequire(npmRequire.resolve("glob"))("minimatch/package.json").version, versions.minimatch);
const zlibPackage = readFileSync("/lib/apk/db/installed", "utf8").split("\n\n").find((entry) => /^P:zlib$/m.test(entry));
versions.zlib = zlibPackage?.match(/^V:(.+)$/m)?.[1];
assert(versions.zlib, "Installed zlib package missing");
const path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const comparison = execFileSync("apk", ["version", "-t", versions.zlib, "1.4-r0"], {
  env: { PATH: path }, encoding: "utf8", timeout: 10000,
}).trim();
assert(["=", ">"].includes(comparison), `zlib ${versions.zlib} is below 1.4-r0`);

const scratch = mkdtempSync(join(tmpdir(), "9router-runtime-security-"));
try {
  const fixture = join(scratch, "fixture");
  const consumer = join(scratch, "consumer");
  const home = join(scratch, "home");
  for (const directory of [fixture, consumer, home]) mkdirSync(directory);
  const env = {
    PATH: path, HOME: home, TMPDIR: scratch,
    NPM_CONFIG_CACHE: join(scratch, "cache"),
    NPM_CONFIG_USERCONFIG: join(scratch, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(scratch, "global-npmrc"),
  };
  const npm = (cwd, args) => execFileSync(process.execPath, [join(npmRoot, "bin/npm-cli.js"), ...args], {
    cwd, env, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024,
  });
  const name = "9router-runtime-security-fixture";
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name, version: "1.0.0", private: true, files: ["*.txt"] }));
  writeFileSync(join(fixture, "keep.txt"), "fixture content\n");
  writeFileSync(join(fixture, "exclude.log"), "excluded\n");
  assert(npmRequire("minimatch").minimatch("keep.txt", "*.txt"));
  assert(!npmRequire("minimatch").minimatch("exclude.log", "*.txt"));
  assert.deepEqual(npmRequire("glob").globSync("*.txt", { cwd: fixture }), ["keep.txt"]);
  const [packed] = JSON.parse(npm(fixture, ["pack", "--offline", "--ignore-scripts", "--json", "--no-audit", "--no-fund"]));
  assert(packed.files.some((file) => file.path === "keep.txt"));
  assert(!packed.files.some((file) => file.path === "exclude.log"));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "runtime-security-consumer", version: "1.0.0", private: true }));
  npm(consumer, ["install", join(fixture, packed.filename), "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"]);
  const installed = join(consumer, "node_modules", name);
  assert.equal(readFileSync(join(installed, "keep.txt"), "utf8"), "fixture content\n");
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, "1.0.0");
  assert(!existsSync(join(installed, "exclude.log")));
  console.log(`Runtime security smoke passed: ${JSON.stringify(versions)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
