import assert from "node:assert/strict";
import test from "node:test";
import { releaseTagFromEnvironment } from "../../scripts/build_schema_artifact.mjs";

test("pull-request refs are not interpreted as schema release tags", () => {
  assert.equal(releaseTagFromEnvironment({
    GITHUB_REF: "refs/pull/3/merge",
    GITHUB_REF_NAME: "3/merge",
    GITHUB_REF_TYPE: "branch",
  }), null);
});

test("tag refs retain strict schema version validation", () => {
  assert.equal(releaseTagFromEnvironment({
    GITHUB_REF: "refs/tags/schema-v0.1.1",
    GITHUB_REF_NAME: "schema-v0.1.1",
    GITHUB_REF_TYPE: "tag",
  }), "schema-v0.1.1");
});

test("local builds without GitHub ref metadata produce an untagged candidate", () => {
  assert.equal(releaseTagFromEnvironment({}), null);
});
