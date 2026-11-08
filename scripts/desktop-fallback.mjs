import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function checkDesktopFallback({
  application,
  page,
  artifacts,
  root,
  projectId,
  checks,
  openAgent,
  closeAgent,
}) {
  await mkdir(root);
  await application.evaluate(
    async (_electron, url) => {
      const p = process.getBuiltinModule("url").fileURLToPath(url),
        require = process.getBuiltinModule("module").createRequire(p);
      const { GPTProvider, ClaudeProvider } = require(p),
        { GeminiProvider } = require(p.replace("providers.js", "gemini.js")),
        { CursorProvider } = require(
          p.replace("providers.js", "cursor-provider.js"),
        );
      const { ClaudeConnection } = require(
          p.replace("providers.js", "claude.js"),
        ),
        { CursorConnection } = require(p.replace("providers.js", "cursor.js")),
        { GeminiConnection } = require(p.replace("providers.js", "gemini.js"));
      ClaudeConnection.prototype.status = async () => ({
        installed: true,
        connected: true,
        login: { waiting: false },
        version: "fixture",
      });
      CursorConnection.prototype.status = async () => ({
        installed: true,
        connected: true,
        login: { waiting: false },
        version: "fixture",
      });
      CursorConnection.prototype.models = async () => [
        { id: "fixture-grok", name: "Cursor fixture model" },
      ];
      GeminiConnection.prototype.models = async () => [
        { id: "fixture-gemini", name: "Gemini fixture model" },
      ];
      globalThis.__quotaFixture = { primary: 0, backup: 0 };
      for (const cls of [GeminiProvider, ClaudeProvider, CursorProvider]) {
        cls.prototype.ready = async () => true;
        for (const action of ["plan", "build", "review", "chat"])
          cls.prototype[action] = GPTProvider.prototype[action];
      }
      GeminiProvider.prototype.build = async () => {
        globalThis.__quotaFixture.primary++;
        const error = new Error("Gemini daily quota exhausted");
        error.code = "usage_limit_reached";
        throw error;
      };
      ClaudeProvider.prototype.build = async (context) => {
        if (context.options.agentId === "grok")
          globalThis.__quotaFixture.backup++;
        return GPTProvider.prototype.build(context);
      };
    },
    pathToFileURL(resolve("src/core/providers.js")).href,
  );
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, root);
  await page.locator("#new-project").click();
  await page.locator("#folder-consent[open]").waitFor();
  await page.locator("#folder-consent-check").check();
  await page.locator("#confirm-folder").click();
  await page.locator("#folder-consent").waitFor({ state: "hidden" });
  const fallbackProject = (await page.evaluate(() => window.tower.projects()))
    .value.activeId;
  assert.notEqual(fallbackProject, projectId);
  await page.locator("#open-settings").click();
  await page.locator("#design-approval").uncheck();
  if (await page.locator("#project-execution").isVisible())
    await page.locator("#project-execution").click();
  await page
    .locator("#project-execution-status")
    .filter({ hasText: "현재 폴더 승인됨" })
    .waitFor();
  await page.locator("#save-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  await page.locator("#open-connections").click();await page.locator("[data-setup-tab=accounts]").click();
  await page.locator("#refresh-status").click();
  await page.locator("#finish-connections").click();
  await page.locator("#open-roles").click();
  await page.locator("#agent-count").selectOption("4");
  for (const [id, provider] of Object.entries({
    gpt: "gpt",
    grok: "gemini",
    claude: "claude",
    reviewer: "grok",
  }))
    await page.locator("#role-" + id).selectOption(provider);
  for (const [id, model] of Object.entries({
    grok: "fixture-gemini",
    reviewer: "fixture-grok",
  })) {
    await page
      .locator(`#panel-model-${id} option[value="${model}"]`)
      .waitFor({ state: "attached" });
    await page.locator("#panel-model-" + id).selectOption(model);
  }
  await page.locator('[data-agent="gpt"] input[value="test"]').check();
  await page
    .locator("#team-editor [data-agent=grok] .fallback-setting summary")
    .click();
  await page.locator("#fallback-grok").selectOption("claude");
  await page.locator(".roles-dialog-panel").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: join(artifacts, "desk-fallback-roles.png") });
  await page
    .locator('#team-editor [data-agent="grok"]')
    .screenshot({ path: join(artifacts, "desk-fallback-setting.png") });
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  const saved = (
    await page.evaluate((id) => window.tower.team(id), fallbackProject)
  ).value;
  assert.equal(saved[1].fallback.provider, "claude");
  assert.equal(saved.length, 4);
  await page
    .locator('[data-desk-agent="grok"] img[src$="provider-gemini.svg"]')
    .waitFor();
  if (await page.locator("#toast").isVisible())
    await page.locator("#toast .toast-dismiss").click();
  await page.screenshot({
    path: join(artifacts, "desk-four-providers-before-fallback.png"),
  });
  await page.locator("#controller-mode").selectOption("work");
  await page.locator('#advanced-validation').evaluate(node=>node.open=true);
  await page.locator('#mutation-option').check();
  await page.locator('#advanced-validation').evaluate(node=>node.open=true);
  await page.locator('#mutation-option').check();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { "test:mutation": "node mutation-fixture.cjs" },
    }),
  );
  await writeFile(
    join(root, "mutation-fixture.cjs"),
    `require('node:fs').writeFileSync(process.env.TOWER_MUTATION_REPORT,JSON.stringify({files:{'counter.cjs':{mutants:[{status:'Killed'}]}}}));`,
  );
  await page.locator("#planner-input").fill("Quota fallback fixture");
  await page.locator("#start-workflow").click();
  await page
    .locator("#project-state")
    .filter({ hasText: "전체 완료" })
    .waitFor({ timeout: 60000 });
  const result = await page.evaluate(
    (id) => window.tower.workflow(id),
    fallbackProject,
  );
  assert.equal(result.ok, true);
  const run = result.value;
  assert.equal(run.status, "completed");
  assert.equal(run.options.team[1].provider, "gemini");
  assert.equal(run.options.runtimeRoutes.grok.provider, "claude");
  assert.equal(
    run.tasks.find((task) => task.id === "logic").executedProvider,
    "claude",
  );
  assert.ok(
    run.events.some(
      (event) =>
        event.activity === "fallback" &&
        event.fromProvider === "gemini" &&
        event.provider === "claude",
    ),
  );
  assert.equal(run.usage.byPanel.grok.providers.gemini, 1);
  assert.ok(run.usage.byPanel.grok.providers.claude >= 1);
  const calls = await application.evaluate(() => globalThis.__quotaFixture);
  assert.equal(calls.primary, 1);
  assert.equal(calls.backup, 1);
  assert.equal(
    await readFile(join(root, "counter.cjs"), "utf8"),
    "exports.value=2;",
  );
  await page
    .locator('[data-desk-agent="grok"] img[src$="provider-claude.svg"]')
    .waitFor();
  assert.match(
    await page.locator('.desk-agent-card[data-actor="grok"]').innerText(),
    /대체 연결/,
  );
  if (await page.locator("#toast").isVisible())
    await page.locator("#toast .toast-dismiss").click();
  await page.screenshot({
    path: join(artifacts, "desk-four-providers-after-fallback.png"),
  });
  await openAgent(page, "grok");
  assert.match(
    await page.locator("#agent-session-title").innerText(),
    /Claude/,
  );
  await page.locator("#grok-input").fill("Explain the fallback result");
  await page.locator("#grok-input").press("Enter");
  await page
    .locator("#grok-events")
    .filter({ hasText: "Fixture answer for grok" })
    .waitFor();
  const index = (await page.evaluate(() => window.tower.conversationIndex()))
    .value;
  const conversation = (
    await page.evaluate(
      (args) => window.tower.conversation(...args),
      [fallbackProject, index.active[fallbackProject]],
    )
  ).value.conversation;
  assert.equal(
    conversation.messages
      .filter(
        (message) => message.agentId === "grok" && message.role === "assistant",
      )
      .at(-1).provider,
    "claude",
  );
  await closeAgent(page);
  checks.push(
    "A four-provider desktop run exhausts Gemini once, preserves the task and criteria, finishes through Claude and changes the live logo, history, usage and conversation target",
  );
  await page.locator("#notification-bell").click();
  await page.locator("#notification-popover:popover-open").waitFor();
  await page
    .locator("#notification-items")
    .filter({ hasText: "사용 한도 소진" })
    .waitFor();
  const first = page.locator(".notification-item").first();
  await first.hover();
  assert.equal(
    await first
      .locator(".notification-delete")
      .evaluate((el) => getComputedStyle(el).opacity),
    "1",
  );
  await page.screenshot({ path: join(artifacts, "desk-notifications.png") });
  const count = await page.locator(".notification-item").count();
  await first.locator(".notification-delete").click();
  await page.waitForFunction(
    (before) =>
      document.querySelectorAll(".notification-item").length === before - 1,
    count,
  );
  await page.locator("#clear-notifications").click();
  await page
    .locator("#notification-items")
    .filter({ hasText: "알림이 없습니다" })
    .waitFor();
  await page.locator("#close-notifications").click();
  assert.equal(
    (await page.evaluate((id) => window.tower.workflow(id), fallbackProject))
      .value.status,
    "completed",
  );
  checks.push(
    "Bell history retains quota notices; hover exposes per-item trash and Clear all deletes notifications without modifying completed work",
  );
  await page.clock.install();
  await page.locator("#open-settings").click();
  await page.locator("#save-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  await page.locator("#toast").waitFor();
  await page.clock.runFor(10050);
  assert.equal(await page.locator("#toast").isVisible(), false);
  await page.locator("#notification-bell").click();
  await page
    .locator("#notification-items")
    .filter({ hasText: "작업 환경 설정을 저장했습니다" })
    .waitFor();
  await page.locator("#close-notifications").click();
  checks.push(
    "Transient notification closes after 10 seconds while its message remains available through the bell",
  );
  await checkAutomaticPool({
    application,
    page,
    projectId: fallbackProject,
    checks,
  });
  await page
    .locator(`.project-group[data-project="${projectId}"] .project-folder`)
    .click();
  await page.waitForFunction(
    (id) =>
      window.tower.projects().then((result) => result.value.activeId === id),
    projectId,
  );
  const notice = await page.evaluate(() =>
    window.tower.addNotification({
      message: "Persistent desktop notification fixture",
      key: "restart-fixture",
    }),
  );
  assert.equal(notice.ok, true);
}

async function checkAutomaticPool({ application, page, projectId, checks }) {
  await application.evaluate(
    async ({ dialog }, url) => {
      const p = process.getBuiltinModule("url").fileURLToPath(url),
        require = process.getBuiltinModule("module").createRequire(p),
        { GPTProvider } = require(p),
        { CursorProvider } = require(
          p.replace("providers.js", "cursor-provider.js"),
        ),
        { UsageService } = require(p.replace("providers.js", "usage.js"));
      globalThis.__cursorUI = { approved: false, prompts: [], calls: 0 };
      CursorProvider.prototype.build = async (context) => {
        if (context.task.kind === "ui") globalThis.__cursorUI.calls++;
        return GPTProvider.prototype.build(context);
      };
      UsageService.prototype.snapshot = () => ({
        checkedAt: new Date().toISOString(),
        providers: {
          codex: {
            state: "available",
            remainingPercent: 40,
            checkedAt: new Date().toISOString(),
            meters: [],
            message: "fixture 40%",
          },
          claude: {
            state: "available",
            remainingPercent: 10,
            checkedAt: new Date().toISOString(),
            meters: [],
            message: "fixture 10%",
          },
          grok: {
            state: "unsupported",
            meters: [],
            remainingPercent: null,
            message: "fixture unknown",
          },
        },
      });
      dialog.showMessageBox = async (_window, options) => {
        if (options.title === "Cursor UI 구현 확인") {
          globalThis.__cursorUI.prompts.push({
            message: options.message,
            buttons: options.buttons,
            defaultId: options.defaultId,
          });
          return { response: globalThis.__cursorUI.approved ? 1 : 0 };
        }
        return { response: 1 };
      };
    },
    pathToFileURL(resolve("src/core/providers.js")).href,
  );
  await page.locator("#open-roles").click();
  await page
    .locator("#team-editor [data-agent=grok] .fallback-setting summary")
    .click();
  await page.locator("#fallback-grok").selectOption("");
  await page.locator("#role-claude").selectOption("grok");
  await page
    .locator("#panel-model-claude option[value=fixture-grok]")
    .waitFor({ state: "attached" });
  await page.locator("#panel-model-claude").selectOption("fixture-grok");
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  const configured = (
    await page.evaluate((id) => window.tower.team(id), projectId)
  ).value;
  assert.equal(
    configured[1].fallback,
    undefined,
    "Manual fallback should be cleared before the automatic-pool run",
  );
  assert.equal(configured[2].provider, "grok");
  await page.locator("#new-conversation").click();
  await page
    .locator("#conversation-title")
    .filter({ hasText: "새 대화" })
    .waitFor();
  await page.locator("#controller-mode").selectOption("work");
  await page
    .locator("#planner-input")
    .fill("Automatic pool and denied Cursor UI fixture");
  await page.locator("#start-workflow").click();
  let run = await waitForRun(
    page,
    projectId,
    "Automatic pool and denied Cursor UI fixture",
    "needs_attention",
    state => /승인하지/.test(state.events.at(-1)?.message ?? ''),
  );
  assert.equal(run.options.runtimeRoutes.grok.provider, "gpt");
  assert.equal(run.options.team[1].fallback, undefined);
  assert.match(run.events.at(-1).message, /승인하지/);
  const denied = await application.evaluate(() => globalThis.__cursorUI);
  assert.equal(denied.calls, 0);
  assert.equal(denied.prompts.length, 1);
  assert.equal(denied.prompts[0].defaultId, 0);
  assert.match(denied.prompts[0].message, /추천하지 않습니다/);
  checks.push(
    "Without a manual backup the real desktop coordinator transfers an exhausted task to GPT 40% instead of Claude 10%, and cancelled Cursor UI approval makes zero UI calls",
  );
  await application.evaluate(() => {
    globalThis.__cursorUI.approved = true;
  });
  await page.locator('#advanced-validation').evaluate(node=>node.open=true);
  await page.locator('#mutation-option').check();
  await page.locator("#planner-input").fill("Approved Cursor UI fixture");
  await page.locator("#start-workflow").click();
  run = await waitForRun(
    page,
    projectId,
    "Approved Cursor UI fixture",
    "completed",
  );
  assert.equal(run.validation.passed, true);
  assert.equal(run.mutation.passed, true);
  assert.equal(run.options.runtimeRoutes.grok.provider, "gpt");
  const approved = await application.evaluate(() => globalThis.__cursorUI);
  assert.equal(approved.calls, 1);
  assert.equal(approved.prompts.length, 2);
  assert.equal(
    run.tasks.find((task) => task.kind === "ui").executedProvider,
    "grok",
  );
  checks.push(
    "Explicit native Cursor UI approval permits exactly the intended UI request, with real Node verification and explicitly selected advanced mutation flow completing afterward",
  );
}
async function waitForRun(page, projectId, request, status, settled = () => true) {
  const deadline = Date.now() + 60000;
  let state;
  while (Date.now() < deadline) {
    state = (await page.evaluate((id) => window.tower.workflow(id), projectId))
      .value;
    if (state?.request === request && state.status === status && settled(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Expected ${request}/${status}, got ${state?.request}/${state?.status}: ${await page.locator("#footer-status").innerText()}`,
  );
}
