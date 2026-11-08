import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { Projects } from "../src/core/projects.js";
import { Workspace, relativeFile } from "../src/core/workspace.js";
import { Workflow } from "../src/core/workflow.js";
import { RoleAssignments, roleProviders } from "../src/core/roles.js";
import { validateTeam, resizeTeam, defaultTeam } from "../src/core/team.js";
import { compileFunPlan } from "../src/core/fun-contract.js";
import { nativeEnvironment } from "../src/core/child-env.js";
import { validateProject } from "../src/core/validation.js";
import { officialExternalURL } from "../src/core/browser.js";

function contract(team) {
  const workers = team.filter((agent) => !agent.roles.includes("control"));
  return {
    contractVersion: 1,
    version: "1.0.0",
    questions: [],
    requirements: [
      {
        id: "R1",
        title: "Counter",
        context: "Idle app",
        trigger: "Start clicked",
        reaction: "Counter runs",
        acceptanceCriteria: ["Counter changes"],
      },
      {
        id: "R2",
        title: "Screen",
        context: "Loaded app",
        trigger: "UI renders",
        reaction: "Controls visible",
        acceptanceCriteria: ["Start button exists"],
      },
    ],
    decisions: [
      { id: "D1", description: "Local-only application", source: "user" },
    ],
    reviewItems: [{ description: "Confirm visual spacing", critical: false }],
    design: {
      screens: [
        {
          name: "Main",
          layout: "Counter above controls",
          states: ["idle", "running", "error"],
        },
      ],
      palette: ["mint on black"],
      spacing: "8px grid",
      typography: "system sans",
    },
    tasks: [
      {
        id: "logic",
        title: "Counter",
        owner: workers.find((agent) => agent.roles.includes("feature")).id,
        kind: "feature",
        requirementIds: ["R1"],
        instructions: "Implement counter",
        dependsOn: [],
        acceptanceCriteria: ["Counter changes"],
      },
      {
        id: "screen",
        title: "Screen",
        owner: team.find((agent) => agent.roles.includes("ui")).id,
        kind: "ui",
        requirementIds: ["R2"],
        instructions: "Implement controls",
        dependsOn: [],
        acceptanceCriteria: ["Start button exists"],
      },
    ],
  };
}
async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), "cw-team-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  await mkdir(root);
  const store = new Store(join(base, "data"), {});
  await store.init();
  const projects = new Projects(store);
  const id = (await projects.list()).activeId;
  const workspace = new Workspace(projects);
  const ticket = await workspace.prepare(id, root);
  await workspace.consent(id, ticket.ticket, true);
  return { base, root, store, projects, workspace, id };
}
test("2..4 panels allow one GPT login, duplicate capabilities and multi-role agents; invalid teams fail", () => {
  const two = resizeTeam(
    defaultTeam({ gpt: "gpt", grok: "gpt", claude: "gpt" }),
    2,
  );
  assert.deepEqual(two[1].roles, ["feature", "debug", "review", "ui", "test", "critic"]);
  assert.ok(two[0].roles.includes("test"));
  assert.ok(two.every((agent) => agent.provider === "gpt"));
  const four = resizeTeam(two, 4);
  assert.equal(four.length, 4);
  assert.ok(four[1].roles.includes("ui") && !four[2].roles.includes("ui"));
  assert.deepEqual(four[3].roles, ["debug", "review", "critic", "test"]);
  assert.throws(() => validateTeam(two.slice(0, 1)));
  assert.throws(() =>
    validateTeam([...four, { id: "fifth", provider: "gpt", roles: ["debug"] }]),
  );
  assert.throws(() =>
    validateTeam([
      { ...two[0] },
      { ...two[1], roles: ["control", "feature", "ui"] },
    ]),
  );
});
test("old projects migrate to a default three-panel team; two-panel multi-role configuration survives reload", async (t) => {
  const f = await setup(t),
    roles = new RoleAssignments(f.projects);
  assert.equal((await roles.getTeam(f.id)).length, 3);
  const two = resizeTeam(await roles.getTeam(f.id), 2);
  two.forEach((agent) => {
    agent.provider = "gpt";
  });
  await roles.setTeam(f.id, two);
  assert.deepEqual(
    await new RoleAssignments(new Projects(f.store)).getTeam(f.id),
    two,
  );
});
test("Fun compiler rejects missing CTR, unimplemented requirements and wrong role ownership; emits Gherkin and review list", () => {
  const team = resizeTeam(defaultTeam(), 2).map(row=>({...row,roles:row.roles.filter(role=>role!=="test")})),
    plan = contract(team);
  const compiled = compileFunPlan(plan, { team });
  assert.match(compiled.spec, /Given Idle app/);
  assert.match(compiled.spec, /When Start clicked/);
  assert.match(compiled.spec, /Then Counter runs/);
  assert.match(compiled.spec, /Confirm visual spacing/);
  const missing = structuredClone(plan);
  delete missing.requirements[0].trigger;
  assert.throws(() => compileFunPlan(missing, { team }), /Trigger/);
  const uncovered = structuredClone(plan);
  uncovered.tasks.pop();
  assert.throws(() => compileFunPlan(uncovered, { team }), /구현 작업/);
  const wrong = structuredClone(plan);
  wrong.tasks[0].owner = "gpt";
  assert.throws(() => compileFunPlan(wrong, { team }), /패널 역할/);
  const critical = structuredClone(plan);
  critical.reviewItems = [
    { description: "External payment permission is missing", critical: true },
  ];
  assert.equal(compileFunPlan(critical, { team }).tasks.length, 0);
});
for (const count of [2, 3, 4])
  test(`${count} GPT-only panels execute their real coordinator routes and bounded final review independently`, async (t) => {
    const f = await setup(t);
    const team = resizeTeam(
      defaultTeam({ gpt: "gpt", grok: "gpt", claude: "gpt" }),
      count,
    ).map(row=>({...row,roles:row.roles.filter(role=>role!=="test")}));
    let active = 0,
      maxActive = 0,
      reviews = 0;
    const owners = new Set();
    let release;
    const together = new Promise((resolve) => {
      release = resolve;
    });
    const provider = {
      ready: async () => true,
      plan: async () => contract(team),
      build: async (context) => {
        active++;
        maxActive = Math.max(maxActive, active);
        owners.add(context.options.agentId);
        if (count > 2) {
          if (active === 2) release();
          await together;
        }
        active--;
        return {
          summary: "fixture work included",
          files: [
            { path: context.task.id + ".txt", content: context.task.kind },
          ],
        };
      },
      review: async () => {
        reviews++;
        return { summary: "fixture review", issues: [] };
      },
    };
    const engine = new Workflow(
      f.workspace,
      roleProviders({ gpt: provider }),
      () => {},
      async () => ({
        configured: true,
        passed: true,
        summary: "fixture validation",
      }),
    );
    await engine.start(f.id, {
      request: "Build a local counter",
      maxRepairRounds: 0,
      team,
      funContract: true,
      unattended: true,
    });
    await engine.runs.get(f.id).promise;
    const state = await engine.current(f.id);
    assert.equal(state.status, "completed");
    assert.equal(state.requirements.length, 2);
    assert.equal(state.governance.contractVersion, 1);
    assert.equal(reviews, count);
    assert.ok(owners.has("grok"));
    if (count > 2) {
      assert.ok(owners.has("claude"));
      assert.equal(maxActive, 2);
    } else assert.equal(maxActive, 1);
    assert.equal(await readFile(join(f.root, "screen.txt"), "utf8"), "ui");
  });
test("foreign-machine vault envelope is never decrypted or reused even with the same test codec", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "cw-binding-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const codec = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text),
    decryptString: (buffer) => buffer.toString(),
  };
  const original = new Store(base, codec, async () => "device-user-A");
  await original.init();
  await original.mutateSecrets((vault) => {
    vault.account = "private-account-A";
  });
  let decrypts = 0;
  const other = new Store(
    base,
    {
      ...codec,
      decryptString: (buffer) => {
        decrypts++;
        return buffer.toString();
      },
    },
    async () => "device-user-B",
  );
  assert.deepEqual(await other.secrets(), {});
  assert.equal(decrypts, 0);
  assert.ok(other.securityNotice);
  await other.mutateSecrets((vault) => {
    vault.account = "account-B";
  });
  assert.deepEqual(await other.secrets(), { account: "account-B" });
});
test("credential paths and inherited developer keys cannot enter worker context or child environments", () => {
  for (const path of [
    ".codex/auth.json",
    ".claude/settings.json",
    ".gemini/oauth_creds.json",
    ".ssh/id_ed25519",
    ".aws/credentials",
    ".npmrc",
    "auth.json",
    "vault.foreign.backup.enc",
  ])
    assert.throws(() => relativeFile(path));
  const saved = process.env.CW_TEST_API_KEY;
  process.env.CW_TEST_API_KEY = "non-secret-unit-sentinel";
  try {
    assert.equal(nativeEnvironment().CW_TEST_API_KEY, undefined);
    assert.ok(
      Object.keys(nativeEnvironment()).some(
        (key) => key.toLowerCase() === "path",
      ),
    );
  } finally {
    if (saved === undefined) delete process.env.CW_TEST_API_KEY;
    else process.env.CW_TEST_API_KEY = saved;
  }
});
test("validation uses trusted absolute npm, suppresses lifecycle hooks and cannot launch project npm.cmd", async (t) => {
  const f = await setup(t);
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: {
        pretest: "node hook.cjs",
        test: "node check.cjs",
        posttest: "node hook.cjs",
      },
    }),
  );
  await writeFile(
    join(f.root, "hook.cjs"),
    'require("node:fs").writeFileSync("hook-ran","bad")',
  );
  await writeFile(join(f.root, "check.cjs"), 'console.log("intended script")');
  await writeFile(join(f.root, "npm.cmd"), "@echo hijacked>shadow-ran\r\n");
  const result = await validateProject(f.workspace, {
    projectId: f.id,
    grantId: (await f.workspace.grant(f.id)).grantId,
    options: { allowExecution: true, validationScript: "test" },
    signal: new AbortController().signal,
  });
  assert.equal(result.passed, true);
  assert.match(result.output, /intended script/);
  await assert.rejects(readFile(join(f.root, "hook-ran")));
  await assert.rejects(readFile(join(f.root, "shadow-ran")));
});
test("copied or legacy folder consent cannot authorize a different device/user", async (t) => {
  const f = await setup(t);
  const foreign = new Workspace(f.projects, async () => "other-device");
  await assert.rejects(foreign.grant(f.id), /PC·OS/);
  const data = await f.projects.list();
  delete data.items.find((project) => project.id === f.id).workspace
    .deviceBinding;
  await f.store.write("projects", data);
  await assert.rejects(f.workspace.grant(f.id), /다시 연결/);
});
test("browser opener rejects executable schemes, credentials and lookalike hosts before OS launch", () => {
  for (const url of [
    "file:///C:/test.exe",
    "https://auth.openai.com.attacker.invalid",
    "https://user:password@cursor.com/login",
    "http://claude.ai",
    "https://cursor.com:444/login",
  ])
    assert.throws(() => officialExternalURL(url));
  assert.equal(
    officialExternalURL("https://auth.openai.com/authorize?state=unit"),
    "https://auth.openai.com/authorize?state=unit",
  );
});
