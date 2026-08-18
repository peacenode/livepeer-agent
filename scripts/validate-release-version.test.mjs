import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertReleaseVersion, parseArguments } from "./validate-release-version.mjs";

test("accepts a tag, package, artifact, and binary with one version", () => {
  assert.equal(assertReleaseVersion({
    tag: "v0.1.0",
    manifestVersion: "0.1.0",
    artifactVersion: "0.1.0",
    binaryVersion: "0.1.0",
  }), "0.1.0");
});

test("rejects a release tag that differs from the CLI package", () => {
  assert.throws(
    () => assertReleaseVersion({ tag: "v0.2.0", manifestVersion: "0.1.0" }),
    /expected v0\.1\.0/u,
  );
});

test("rejects artifact and binary version mismatches", () => {
  assert.throws(
    () => assertReleaseVersion({ tag: "v0.1.0", manifestVersion: "0.1.0", artifactVersion: "0.0.0" }),
    /artifact version 0\.0\.0/u,
  );
  assert.throws(
    () => assertReleaseVersion({ tag: "v0.1.0", manifestVersion: "0.1.0", binaryVersion: "0.0.0" }),
    /binary version 0\.0\.0/u,
  );
});

test("requires explicit, well-formed arguments", () => {
  assert.deepEqual(parseArguments(["v0.1.0", "--artifact", "release.tgz", "--binary", "dist/index.js"]), {
    tag: "v0.1.0",
    artifact: "release.tgz",
    binary: "dist/index.js",
  });
  assert.throws(() => parseArguments([]), /Usage:/u);
  assert.throws(() => parseArguments(["v0.1.0", "--artifact"]), /requires a value/u);
});

test("the command exits nonzero for a mismatched tag", () => {
  const script = fileURLToPath(new URL("./validate-release-version.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "v9.9.9"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match CLI package version 0\.1\.1/u);
});
