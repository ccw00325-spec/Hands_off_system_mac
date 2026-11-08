import test from "node:test";
import assert from "node:assert/strict";
import { roleProviders } from "../src/core/roles.js";
import {
  defaultTeam,
  validateTeam,
  teamFor,
  exclusiveTeam,
} from "../src/core/team.js";
import { remainingQuota } from "../src/core/quota-routing.js";
import { providerFailure } from "../src/core/provider-errors.js";
import { Workflow } from "../src/core/workflow.js";
const snapshot = (gpt = 40, claude = 10) => ({
  providers: {
    codex: {
      state: "available",
      checkedAt: new Date().toISOString(),
      remainingPercent: gpt,
    },
    claude: {
      state: "available",
      checkedAt: new Date().toISOString(),
      remainingPercent: claude,
    },
  },
});
const quota = () =>
  providerFailure("grok", { code: "usage_limit_reached" }, "quota exhausted");
const options = () => ({
  team: defaultTeam(),
  autoFallback: true,
  maxAgentCalls: 20,
});
test("new defaults have exclusive implementation owners and shared review/debug/test responsibilities", () => {
  const team = defaultTeam();
  assert.deepEqual(
    team.map((row) => row.roles),
    [
      ["control", "debug", "review", "test"],
      ["feature", "debug", "review"],
      ["ui", "review", "critic"],
    ],
  );
  validateTeam(team, { exclusive: true });
  const duplicate = structuredClone(team);
  duplicate[0].roles.push("feature");
  assert.throws(() => validateTeam(duplicate, { exclusive: true }), /한 AI/);
  assert.equal(
    exclusiveTeam(duplicate).filter((row) => row.roles.includes("feature"))
      .length,
    1,
  );
  assert.throws(
    () =>
      teamFor({
        ...options(),
        runtimeRoutes: { grok: { provider: "gemini" } },
      }),
    /일치/,
  );
  assert.equal(
    teamFor({ ...options(), runtimeRoutes: { grok: { provider: "gpt" } } })[1]
      .provider,
    "gpt",
  );
});
test("remaining quota uses only fresh measured active limits and keeps unsupported sources unknown", () => {
  assert.equal(remainingQuota(snapshot(), "gpt"), 40);
  assert.equal(remainingQuota(snapshot(), "grok"), null);
  const value = snapshot();
  value.providers.codex.checkedAt = "2000-01-01";
  assert.equal(remainingQuota(value, "gpt"), null);
  value.providers.codex = {
    state: "available",
    checkedAt: new Date().toISOString(),
    meters: [
      { remainingPercent: 1, active: false },
      { remainingPercent: 20, active: true },
    ],
  };
  assert.equal(remainingQuota(value, "gpt"), 20);
  assert.equal(remainingQuota(snapshot(), "gpt", { gptSource: "api" }), null);
});
test("usage monitoring failure does not prevent ordinary work or quota recovery", async () => {
  let worked = 0;
  const providers = roleProviders(
    {
      grok: {
        build: async () => {
          throw quota();
        },
      },
      gpt: {
        ready: async () => true,
        build: async () => {
          worked++;
          return { summary: "recovered" };
        },
      },
      claude: { ready: async () => false },
    },
    {
      getUsage: () => {
        throw new Error("usage unavailable");
      },
    },
  );
  await providers.grok.build({ options: options(), task: { kind: "feature" } });
  assert.equal(worked, 1);
});
test("Cursor exhaustion without a manual backup chooses GPT 40% over Claude 10% and preserves request context", async () => {
  const config = options(),
    context = {
      options: config,
      task: { id: "feature-1", kind: "feature" },
      snapshot: { files: [{ path: "saved.js", content: "saved checkpoint" }] },
      spec: "fixed criteria",
      signal: new AbortController().signal,
    };
  let cursor = 0,
    gpt = 0,
    claude = 0;
  const providers = roleProviders(
    {
      grok: {
        build: async () => {
          cursor++;
          throw quota();
        },
      },
      gpt: {
        ready: async () => true,
        build: async (c) => {
          gpt++;
          assert.equal(c.snapshot, context.snapshot);
          assert.equal(c.task.id, "feature-1");
          assert.equal(c.spec, "fixed criteria");
          return { summary: "continued" };
        },
      },
      claude: { ready: async () => true, build: async () => claude++ },
    },
    { getUsage: () => snapshot() },
  );
  await providers.grok.build(context);
  assert.equal(cursor, 1);
  assert.equal(gpt, 1);
  assert.equal(claude, 0);
  assert.equal(config.runtimeRoutes.grok.provider, "gpt");
  assert.deepEqual(config.exhaustedProviders, ["grok"]);
});
test("a fresh 3% limit transfers before the next request; stale or unsupported quota does not preempt", async () => {
  for (const fresh of [true, false]) {
    let primary = 0,
      backup = 0;
    const config = options();
    config.team[1].provider = "claude";
    config.team[2].provider = "gpt";
    const data = snapshot(40, 3);
    if (!fresh) data.providers.claude.checkedAt = "2000-01-01";
    const providers = roleProviders(
      {
        claude: {
          ready: async () => true,
          build: async () => {
            primary++;
            return { summary: "primary" };
          },
        },
        gpt: {
          ready: async () => true,
          build: async () => {
            backup++;
            return { summary: "backup" };
          },
        },
      },
      { getUsage: () => data },
    );
    await providers.grok.build({
      options: config,
      task: { id: "one", kind: "feature" },
    });
    assert.equal(primary, fresh ? 0 : 1);
    assert.equal(backup, fresh ? 1 : 0);
  }
});
test("automatic pool skips unready and exhausted providers, and stops after each candidate without a loop", async () => {
  let requests = 0;
  const config = options(),
    providers = roleProviders(
      Object.fromEntries(
        ["gpt", "grok", "claude"].map((provider) => [
          provider,
          {
            ready: async () => true,
            build: async () => {
              requests++;
              throw quota();
            },
          },
        ]),
      ),
      { getUsage: () => snapshot() },
    );
  await assert.rejects(
    providers.grok.build({ options: config, task: { kind: "feature" } }),
    /한도 소진/,
  );
  assert.equal(requests, 3);
  assert.equal(new Set(config.exhaustedProviders).size, 3);
});
test("Cursor UI implementation needs explicit host approval and cancellation sends no provider request", async () => {
  for (const approve of [false, true]) {
    let requests = 0,
      prompts = 0;
    const config = options();
    config.team[2].provider = "grok";
    const providers = roleProviders(
      {
        grok: {
          build: async () => {
            requests++;
            return { summary: "ui" };
          },
        },
      },
      {
        confirmCursorUI: async () => {
          prompts++;
          return approve;
        },
      },
    );
    const context = {
      options: config,
      task: { id: "screen", kind: "ui" },
      signal: new AbortController().signal,
    };
    if (approve) {
      await providers.claude.build(context);
      await providers.claude.build(context);
      assert.equal(requests, 2);
      assert.equal(prompts, 1);
    } else {
      await assert.rejects(providers.claude.build(context), /승인하지/);
      assert.equal(requests, 0);
    }
  }
});
test("automatic replacement still observes the host call cap and reports the actual executing provider", async () => {
  let gpt = 0;
  const config = options();
  config.maxAgentCalls = 1;
  const engine = new Workflow(
    {},
    roleProviders(
      {
        grok: {
          build: async () => {
            throw quota();
          },
        },
        gpt: { ready: async () => true, build: async () => gpt++ },
        claude: { ready: async () => false },
      },
      { getUsage: () => snapshot() },
    ),
  );
  engine.record = async () => {};
  await assert.rejects(
    engine.callAgent(
      { state: { projectId: "p", options: config } },
      "grok",
      "build",
      {
        options: config,
        task: { id: "one", kind: "feature" },
        signal: new AbortController().signal,
        snapshot: { files: [] },
      },
    ),
    /호출 한도/,
  );
  assert.equal(gpt, 0);
});
