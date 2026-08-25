import assert from "node:assert/strict";
import test from "node:test";
import { githubRelayIdentityFromEnvironment } from "../src/hosted.ts";

const EXPLICIT = {
  AGENT_FEED_GITHUB_RELAY_REPOSITORY: "wesleykao1990/agent-feed",
  AGENT_FEED_GITHUB_RELAY_REPOSITORY_ID: "1337089949",
  AGENT_FEED_GITHUB_RELAY_REF: "refs/heads/main",
  AGENT_FEED_GITHUB_RELAY_WORKFLOW_REF:
    "wesleykao1990/agent-feed/.github/workflows/agent-feed-relay.yml@refs/heads/main",
};

test("explicit relay identity works without Vercel Git runtime metadata", () => {
  assert.deepEqual(
    githubRelayIdentityFromEnvironment({ ...EXPLICIT }),
    {
      repository: "wesleykao1990/agent-feed",
      repository_id: "1337089949",
      ref: "refs/heads/main",
      workflow_ref:
        "wesleykao1990/agent-feed/.github/workflows/agent-feed-relay.yml@refs/heads/main",
    },
  );
});

test("explicit relay identity takes precedence over Vercel Git metadata", () => {
  assert.deepEqual(
    githubRelayIdentityFromEnvironment({
      ...EXPLICIT,
      VERCEL_GIT_REPO_ID: "999",
      VERCEL_GIT_REPO_OWNER: "other",
      VERCEL_GIT_REPO_SLUG: "other",
      VERCEL_GIT_COMMIT_REF: "other",
    }),
    {
      repository: "wesleykao1990/agent-feed",
      repository_id: "1337089949",
      ref: "refs/heads/main",
      workflow_ref:
        "wesleykao1990/agent-feed/.github/workflows/agent-feed-relay.yml@refs/heads/main",
    },
  );
});

test("partial explicit relay identity fails closed", () => {
  assert.throws(
    () =>
      githubRelayIdentityFromEnvironment({
        AGENT_FEED_GITHUB_RELAY_REPOSITORY: "wesleykao1990/agent-feed",
      }),
    /agent_feed_github_relay_config_incomplete/u,
  );
});

test("legacy Vercel Git metadata remains a complete fallback", () => {
  assert.deepEqual(
    githubRelayIdentityFromEnvironment({
      VERCEL_GIT_REPO_ID: "1337089949",
      VERCEL_GIT_REPO_OWNER: "wesleykao1990",
      VERCEL_GIT_REPO_SLUG: "agent-feed",
      VERCEL_GIT_COMMIT_REF: "main",
    }),
    {
      repository: "wesleykao1990/agent-feed",
      repository_id: "1337089949",
      ref: "refs/heads/main",
      workflow_ref:
        "wesleykao1990/agent-feed/.github/workflows/agent-feed-relay.yml@refs/heads/main",
    },
  );
});

test("no relay identity leaves GitHub OIDC disabled", () => {
  assert.equal(githubRelayIdentityFromEnvironment({}), undefined);
});
