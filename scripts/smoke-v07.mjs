import { _electron as electron } from "@playwright/test";
import { mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { checkDesktopFallback } from "./desktop-fallback.mjs";
import {workspaceWindow} from './electron-workspace.mjs';
const artifacts = resolve("artifacts");
const releaseVersion = JSON.parse(
  await readFile("package.json", "utf8"),
).version;
await mkdir(artifacts, { recursive: true });
const profile = join(artifacts, "smoke-v07-profile-" + Date.now()),
  root = join(artifacts, "smoke-v07-workspace-" + Date.now());
const fallbackRoot=join(artifacts,"smoke-fallback-workspace-"+Date.now());
await mkdir(root);
const env = { ...process.env, TOWER_TEST_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
let application, debugPage;
const errors = [];
async function boot() {
  application = await electron.launch({ args: ["."], cwd: resolve("."), env });
  await application.evaluate((_electron,url)=>{
    const p=process.getBuiltinModule('url').fileURLToPath(url),require=process.getBuiltinModule('module').createRequire(p);
    require(p.replace('codex.js','prerequisites.js')).Prerequisites.prototype.scan=async()=>({rows:[],needsAttention:false,platform:process.platform,arch:process.arch});
    require(p).CodexConnection.prototype.models=async()=>[{id:'fixture-native-model',name:'Fixture model'}];
    require(p).CodexConnection.prototype.status=async()=>({installed:true,connected:true,state:'connected',login:{waiting:false}});
    require(p.replace('codex.js','cursor.js')).CursorConnection.prototype.models=async()=>[{id:'fixture-grok',name:'Cursor fixture model'}];
    require(p.replace('codex.js','cursor.js')).CursorConnection.prototype.status=async()=>({installed:true,connected:true,login:{waiting:false}});
    require(p.replace('codex.js','gemini.js')).GeminiConnection.prototype.models=async()=>[{id:'fixture-gemini',name:'Gemini fixture model'}];
    require(p.replace('codex.js','gemini.js')).GeminiConnection.prototype.status=async()=>({installed:true,connected:true,login:{waiting:false}});
    require(p.replace('codex.js','claude.js')).ClaudeConnection.prototype.status=async()=>({installed:true,connected:true,login:{waiting:false}});
  },pathToFileURL(resolve('src/core/codex.js')).href);
  const page = await workspaceWindow(application);
  debugPage = page;
  const storage=await application.evaluate(({app})=>({userData:app.getPath("userData"),sessionData:app.getPath("sessionData")}));
  assert.equal(storage.userData,profile);assert.equal(storage.sessionData,profile);
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .locator("#session-status[data-restoring=false]")
    .waitFor({ state: "attached", timeout: 90000 });
  await page.waitForFunction(()=>window.tower.startupState().then(result=>result.value.percent===100));
  return page;
}
async function closeAgent(page) {
  if(await page.locator("#agent-session-dialog").evaluate(el=>el.open)) {
    await page.locator("#close-agent-session").click();
    await page.locator("#agent-session-dialog").waitFor({state:"hidden"});
  }
}
async function closeWorkflow(page) {
  if(await page.locator("#workflow-dialog").evaluate(el=>el.open)) {
    await page.locator("#close-workflow-dialog").click();
    await page.locator("#workflow-dialog").waitFor({state:"hidden"});
  }
}
async function openWorkflow(page) {
  await closeAgent(page);
  if(!(await page.locator("#workflow-dialog").evaluate(el=>el.open)))await page.locator("#desk-workflow-open").click();
  await page.locator("#workflow-dialog[open]").waitFor();
}
async function openAgent(page,actor) {
  await closeAgent(page);await closeWorkflow(page);
  await page.locator(`[data-desk-agent="${actor}"]`).click();
  await page.locator("#agent-session-dialog[open]").waitFor();
}
try {
  let page = await boot();
  assert.equal(
    await page.locator("#app-version").innerText(),
    "LOCAL / " + releaseVersion,
  );
  const tour = page.locator("#first-run-tour");
  await page.locator("#first-run-tour[open]").waitFor();
  await tour.waitFor();
  await page.locator("#tour-next").click();
  assert.match(await page.locator("#tour-title").innerText(), /AI 역할 변경/);
  await page.screenshot({ path: join(artifacts, "first-run-tour.png") });
  await page.locator("#tour-skip").click();
  await tour.waitFor({ state: "hidden" });
  await page.locator("#settings-dialog[open]").waitFor();
  assert.equal(await page.locator("#allow-execution").isChecked(), false);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => typeof window.process), "undefined");
  checks.push(
    "First-run settings ask optional execution consent; renderer has no Node/process access",
  );
  await page.locator("#allow-execution").check();
  assert.equal(await page.locator('#execution-backend').inputValue(),'docker');
  assert.equal(await page.locator('#design-mode').inputValue(),'layout');
  await page.locator('#execution-backend').selectOption('host');
  await application.evaluate(({dialog})=>{const original=dialog.showMessageBox;dialog.showMessageBox=(...args)=>args.at(-1)?.title==='현재 PC에서 실행'?Promise.resolve({response:1}):original(...args);});
  assert.equal(await page.locator("#design-approval").isChecked(), true);
  await page.locator("#terminal-font-size").selectOption("14");
  await page.locator("#save-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert.equal((await page.evaluate(()=>window.tower.startupState())).value.percent,100);
  const originalViewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
  await page.setViewportSize({ width: 1100, height: 560 });
  await page.locator("#open-roles").click();
  const panel = page.locator(".roles-dialog-panel");
  await panel.waitFor();
  const roleBounds=await panel.boundingBox(),closeBounds=await page.locator('#close-roles-outside').boundingBox();
  assert.ok(closeBounds.x>=roleBounds.x+roleBounds.width,'The outside close must remain outside the wider role panel');
  assert.equal(await page.locator('#team-editor input[value=control]').count(),0);
  assert.equal(await page.locator('#mutation-option').isChecked(),false);
  assert.equal(await page.locator('#team-editor button').count(),0);
  assert.equal(await page.locator('#team-editor [data-agent=gpt] input[value=test]').isChecked(),true);
  assert.equal(await page.locator('#team-editor [data-agent=grok] input[value=debug]').isChecked(),true);
  assert.equal(await page.locator('#team-editor [data-agent=claude] input[value=review]').isChecked(),true);
  assert.equal(await page.locator('#team-editor [data-agent=gpt] input[value=feature]').isDisabled(),true);
  await page.locator('#role-gpt').selectOption('gemini');
  await page.locator('#panel-model-gpt option[value=fixture-gemini]').waitFor({state:'attached'});
  assert.match(await page.locator('label[for=panel-model-gpt]').innerText(),/Gemini 모델 선택/);
  await page.locator('#role-gpt').selectOption('gpt');
  await page.locator('#panel-model-gpt option[value=fixture-native-model]').waitFor({state:'attached'});
  await page.locator('#team-editor [data-agent=grok] input[value=feature]').uncheck();
  await page.locator('#team-editor [data-agent=gpt] input[value=feature]').check();
  assert.equal(await page.locator('#team-editor [data-agent=grok] input[value=feature]').isDisabled(),true);
  await page.locator('#team-editor [data-agent=gpt] input[value=feature]').uncheck();
  await page.locator('#team-editor [data-agent=grok] input[value=feature]').check();
  checks.push('Role settings load models automatically on open and provider change, use provider-specific labels, hide fixed control check, and enforce one implementation owner');
  assert.ok(await panel.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  }), "The role form should scroll at a short viewport");
  await page.screenshot({ path: join(artifacts, "role-dialog-close.png") });
  await page.locator("#close-roles-outside").click();
  await panel.waitFor({ state: "hidden" });
  await page.setViewportSize(originalViewport);
  checks.push("First-run tour advances and skips; the outside role close stays clickable after scrolling");
  await page.locator("#open-guide").click();
  await page.locator("#guide-dialog[open]").waitFor();
  assert.equal(await page.locator("#guide-nav button").count(), 8);
  for(const button of await page.locator('#guide-nav button').all()){
    await button.click();await page.locator('#guide-content img').evaluate(image=>image.decode());
    assert.ok((await page.locator('#guide-content dd').count())>=3);
  }
  await page.locator('[data-guide=team]').click();
  await page.screenshot({path:join(artifacts,'guide-role-settings.png')});
  checks.push('Illustrated guide covers eight topics with readable definitions, real app screenshots, mutation prerequisites and actual feature shortcuts');
  await page.keyboard.press("Escape");
  await page.locator("#guide-dialog").waitFor({ state: "hidden" });
  await page.locator("#open-guide").click();
  await page.locator("#replay-tour").click();
  for (let step = 0; step < 4; step++) await page.locator("#tour-next").click();
  await tour.waitFor({ state: "hidden" });
  checks.push(
    "Startup reaches the last local initialization stage; the guide opens and closes by keyboard",
  );
  assert.equal(
    (await page.evaluate(() => window.tower.preferences())).value
      .terminalFontSize,
    14,
  );
  checks.push(
    "Execution, repair limit and terminal preferences persist through dedicated settings",
  );
  await page.locator("#open-connections").click();
  if (await page.locator("#save-key").isEnabled()) {
    await page.locator("#image-api-key").fill("invalid-test-key-not-a-secret");
    await page.locator("#save-key").click();
    await page.locator("#image-api-key[aria-invalid=true]").waitFor();
    assert.equal(await page.locator("#image-api-key").inputValue(), "");
    await application.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        globalThis.__authUrl = url;
      };
    });
    await page.locator("#chatgpt-login").click();
    await page.locator("#cancel-login:not([hidden])").waitFor();
    const auth = new URL(await application.evaluate(() => globalThis.__authUrl));
    assert.equal(auth.origin, "https://auth.openai.com");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    await page.locator("#cancel-login").click();
    checks.push(
      "Invalid API key is cleared; official PKCE browser request cancels without exposing credentials",
    );
  } else {
    assert.equal(await page.locator("#chatgpt-login").isDisabled(), true);
    checks.push("Unavailable OS keyring prevents API key and OAuth credential storage");
  }
  await page.locator("#finish-connections").click();
  const original = (await page.evaluate(() => window.tower.projects())).value
    .items.length;
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.__pickerOptions = options;
      return { canceled: true, filePaths: [] };
    };
  });
  await page.locator("#mission-primary").filter({ hasText: "새 프로젝트" }).click();
  assert.equal(
    (await page.evaluate(() => window.tower.projects())).value.items.length,
    original,
  );
  assert.equal(
    (
      await application.evaluate(() => globalThis.__pickerOptions)
    ).properties.includes("openDirectory"),
    true,
  );
  checks.push(
    "New Project opens native Documents folder picker immediately; cancel creates no orphan project",
  );
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, root);
  await page.locator("#new-project").click();
  await page.locator("#folder-consent[open]").waitFor();
  assert.equal(await page.locator("#folder-consent-check").isChecked(), false);
  assert.equal(
    (await page.evaluate(() => window.tower.projects())).value.items.length,
    original,
  );
  await page.locator("#folder-consent-check").check();
  await page.locator("#confirm-folder").click();
  await page.locator("#folder-consent").waitFor({ state: "hidden" });
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.locator("#open-settings").click();
  await page.locator("#project-execution-status").filter({ hasText: "현재 폴더 미승인" }).waitFor();
  await page.locator("#project-execution").click();
  await page.locator("#project-execution").filter({ hasText: "현재 폴더 코드 실행 승인" }).waitFor();
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.locator("#project-execution").click();
  await page.locator("#project-execution-status").filter({ hasText: "현재 폴더 승인됨" }).waitFor();
  await page.locator("#close-settings").click();
  checks.push("Global execution preference leaves new folders unapproved until the native approval dialog is accepted");
  await page.locator("#folder-consent").waitFor({ state: "hidden" });
  await page.locator("#sidebar-projects .conversation-row.selected").waitFor();
  let data = (await page.evaluate(() => window.tower.projects())).value;
  const projectId = data.activeId;
  await application.evaluate(
    (_electron, url) => {
      const path = process.getBuiltinModule("url").fileURLToPath(url);
      const { AuxiliaryServices } = process
        .getBuiltinModule("module")
        .createRequire(path)(path);
      let vercelConnected = false;
      AuxiliaryServices.prototype.login = async function (service) {
        setTimeout(() => {
          vercelConnected = true;
          this.notify({ type: "service-login", service, connected: true });
        }, 100);
        return { waiting: true };
      };
      AuxiliaryServices.prototype.status = async () => ({
        accounts: {
          github: { installed: true, account: "fixture-user" },
          vercel: { installed: true, account: vercelConnected ? "fixture-vercel" : null },
          supabase: { installed: false, account: null },
        },
        config: null,
        name: "fixture-timer",
        result: null,
      });
    },
    pathToFileURL(resolve("src/core/services.js")).href,
  );
  await page.locator("#open-services").click();
  await page.locator("#services-dialog[open]").waitFor();
  await page
    .locator("#service-github")
    .filter({ hasText: "fixture-user" })
    .waitFor();
  assert.equal(await page.locator("#service-auto-github").isChecked(), false);
  assert.equal(await page.locator("#service-production").isChecked(), false);
  assert.equal(
    await page.locator('[data-service-login="supabase"]').isDisabled(),
    true,
  );
  await page.locator('[data-service-login="vercel"]').click();
  await page.locator("#service-vercel").filter({ hasText: "fixture-vercel" }).waitFor();
  await page.locator("#services-result").filter({ hasText: "계정 연결을 확인했습니다" }).waitFor();
  checks.push("Auxiliary sign-in result automatically refreshes the verified CLI account in the Electron UI");
  await page.locator("#close-services").click();
  await application.evaluate(({ BrowserWindow }, projectId) => {
    BrowserWindow.getAllWindows()[0].webContents.send("tower:event", {
      type: "delivery",
      projectId,
      result: {
        status: "awaiting_approval",
        message: "승인 대기 중",
        pending: {
          id: "fixture",
          service: "github",
          target: "fixture-user/focus-timer",
          action: "비공개 저장소 생성 및 커밋·푸시",
          projectTitle: "타이머",
        },
      },
    });
  }, projectId);
  await page.locator("#release-approval[open]").waitFor();
  assert.match(
    await page.locator("#release-approval-target").innerText(),
    /fixture-user\/focus-timer/,
  );
  assert.equal(await page.locator("#release-remember").isChecked(), false);
  assert.equal(
    await page
      .locator("#release-no")
      .evaluate((button) => document.activeElement === button),
    true,
  );
  await page.keyboard.press("Escape");
  await page.locator("#release-approval").waitFor({ state: "hidden" });
  checks.push(
    "Release approval displays the exact destination and defaults to one-time confirmation",
  );
  checks.push(
    "Auxiliary services show CLI account status and project-specific opt-in defaults",
  );
  checks.push(
    "Project is created atomically after folder consent; left folder tree contains the selected conversation",
  );
  assert.equal(await page.locator("main>.folderbar").count(), 0);
  assert.equal(await page.locator(".planner .run-controls").count(), 0);
  assert.equal(await page.locator(".project-sidebar>h2").count(), 0);
  const layout = await page.evaluate(() => ({
    controller:document.querySelector(".desk-chat").getBoundingClientRect().toJSON(),
    agents:[...document.querySelectorAll(".desk-agent-card")].map(el=>el.getBoundingClientRect().toJSON()),
    logos:[...document.querySelectorAll("[data-desk-agent]")].map(el=>el.getBoundingClientRect().width),
  }));
  assert.equal(layout.agents.length,3);
  assert.ok(layout.agents[0].x>layout.controller.right);
  assert.ok(layout.agents[1].y>=layout.agents[0].bottom);
  assert.ok(layout.logos.every(width=>width>=54));
  assert.equal(await page.locator("#workflow-dialog").evaluate(el=>el.open),false);
  checks.push(
    "Approved chat-first desk places readable provider buttons vertically beside the controller; Workflow is closed by default",
  );
  await application.evaluate(
    (_electron, url) => {
      const p = process.getBuiltinModule("url").fileURLToPath(url),
        require = process.getBuiltinModule("module").createRequire(p);
      const { GPTProvider } = require(p);
      const { ImageService } = require(p.replace("providers.js", "images.js"));
      // This legacy image flow uses a 1px protocol fixture, not a renderable UI.
      // The real visual acceptance/repair gate is covered by check-visual-review.
      const Preferences = require(p.replace('providers.js','preferences.js')).Preferences;
      const previousPreferences = Preferences.prototype.get;
      Preferences.prototype.get = async function(){return {...await previousPreferences.call(this),visualReview:false};};
      const { Store } = require(p.replace("providers.js", "store.js"));
      const { GeminiConnection } = require(p.replace("providers.js", "gemini.js"));
      let geminiConnected = false;
      GeminiConnection.prototype.status = async () => ({
        installed: true, connected: geminiConnected, login: { waiting: false },
      });
      GeminiConnection.prototype.connect = async () => {
        geminiConnected = true;
        return { reused: true, message: "Fixture Google connection" };
      };
      const readSecrets = Store.prototype.secrets;
      Store.prototype.secrets = async function () {
        return { ...await readSecrets.call(this), imageKey: "fixture", geminiImageKey: "fixture" };
      };
      globalThis.designPrompts = [];
      ImageService.prototype.generate = async (prompt, provider) => {
        globalThis.designPrompts.push({ prompt, provider });
        const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/iXsAAAAASUVORK5CYII=";
        return { buffer: Buffer.from(data, "base64"), dataUrl: "data:image/png;base64," + data };
      };
      const { CodexConnection } = require(
        p.replace("providers.js", "codex.js"),
      );
      CodexConnection.prototype.status = async () => ({
        installed: true,
        connected: true,
        state: "connected",
        login: { waiting: false },
      });
      CodexConnection.prototype.models = async () => [
        { id: "fixture-native-model", name: "Fixture model" },
      ];
      GPTProvider.prototype.ready = async () => true;
      globalThis.__chatInputs = [];
      GPTProvider.prototype.chat = async (context) => {
        globalThis.__chatInputs.push({
          agentId: context.options.agentId,
          message: context.message,
          history: context.history,
        });
        if (context.message === "Wait for cancellation")
          return new Promise((resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("fixture cancelled")),
              { once: true },
            );
          });
        return {
          reply:
            "Fixture answer for " +
            context.options.agentId +
            ": " +
            context.message,
        };
      };
      let featureBuilds = 0;
      GPTProvider.prototype.plan = async () => ({
        contractVersion: 1,
        version: "1.0.0",
        questions: [],
        requirements: [
          {
            id: "R1",
            title: "Counter",
            context: "Counter module exists",
            trigger: "Read value",
            reaction: "Value 2",
            acceptanceCriteria: ["Counter equals 2"],
          },
          {
            id: "R2",
            title: "Screen",
            context: "HTML loaded",
            trigger: "Find control",
            reaction: "Start button exists",
            acceptanceCriteria: ["Start button id exists"],
          },
        ],
        decisions: [
          {
            id: "D1",
            description: "Local deterministic fixture",
            source: "user",
          },
        ],
        reviewItems: [],
        design: {
          screens: [
            {
              name: "Main",
              layout: "Counter with button",
              states: ["idle", "error"],
            },
          ],
          palette: ["mint black"],
          spacing: "8px",
          typography: "system",
        },
        testPlan: {
          runner: "node-test",
          files: ["tests/checks.test.cjs"],
          cases: [
            {
              id: "T1",
              requirementId: "R1",
              title: "Counter value",
              type: "unit",
              given: "Module loaded",
              when: "Read value",
              expected: "2",
              steps: ["Load counter.cjs", "Read value", "Compare with 2"],
            },
            {
              id: "T2",
              requirementId: "R2",
              title: "Start control",
              type: "integration",
              given: "HTML exists",
              when: "Read HTML",
              expected: "start-button exists",
              steps: ["Open index.html", "Find start-button"],
            },
          ],
        },
        tasks: [
          {
            id: "logic",
            title: "Counter logic",
            owner: "grok",
            kind: "feature",
            instructions: "Create counter",
            acceptanceCriteria: ["2"],
            requirementIds: ["R1"],
            dependsOn: [],
          },
          {
            id: "ui",
            title: "Timer screen",
            owner: "claude",
            kind: "ui",
            instructions: "Create screen",
            acceptanceCriteria: ["Button exists"],
            requirementIds: ["R2"],
            dependsOn: ["logic"],
          },
          {
            id: "qa",
            title: "Independent tests",
            owner: "gpt",
            kind: "test",
            instructions: "T1 and T2 tests",
            acceptanceCriteria: ["Cases pass"],
            requirementIds: ["R1", "R2"],
            dependsOn: [],
          },
        ],
      });
      GPTProvider.prototype.build = async (context) => {
        if (context.task.kind === "feature")
          return {
            summary: "Fixture feature implementation",
            files: [
              {
                path: "counter.cjs",
                content:
                  "exports.value=" + (++featureBuilds === 1 ? 1 : 2) + ";",
              },
            ],
          };
        if (context.task.kind === "ui")
          return {
            summary: "Fixture UI integration",
            files: [
              {
                path: "index.html",
                content:
                  '<!doctype html><button id="start-button">Start</button>',
              },
            ],
          };
        return {
          summary: "Fixture test code",
          files: [
            {
              path: "tests/checks.test.cjs",
              content:
                "const {test}=require('node:test');const assert=require('node:assert/strict');test('T1 counter',()=>assert.equal(require('../counter.cjs').value,2));test('T2 control',()=>assert.match(require('node:fs').readFileSync('index.html','utf8'),/start-button/));",
            },
          ],
        };
      };
      GPTProvider.prototype.review = async (context) => ({
        summary: "Fixture review of actual test result",
        issues: context.validation.passed
          ? []
          : [
              {
                taskId: "logic",
                owner: "grok",
                file: "counter.cjs",
                description: "Counter must equal 2; actual T1 failed.",
              },
            ],
      });
    },
    pathToFileURL(resolve("src/core/providers.js")).href,
  );
  await page.locator("#open-connections").click();
  await page.locator("#refresh-status").click();
  await page.locator("#finish-connections").click();
  await page.locator("#open-roles").click();
  for (const id of ["gpt", "grok", "claude"])
    await page.locator("#role-" + id).selectOption("gpt");
  await page.locator("[data-agent=gpt] input[value=test]").check();
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(
    (
      await page.evaluate((id) => window.tower.team(id), projectId)
    ).value[0].roles.includes("test"),
    true,
  );
  checks.push(
    "Test design/execution is a real assignable capability; one GPT account can fill all panels",
  );
  await page.locator("#planner-input").fill("/model");
  await page.locator("#planner-input").press("Enter");
  await page.locator("#models-dialog[open] .model-row").first().waitFor();
  await page.locator("#models-dialog .model-row").first().click();
  await page.locator("#models-dialog").waitFor({ state: "hidden" });
  checks.push(
    "/model selects the provider catalog model without starting a workflow",
  );
  await page.locator("#planner-input").fill("Fixture timer with QA");
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { "test:mutation": "node fixture-mutation.cjs" } }));
  await writeFile(join(root, "fixture-mutation.cjs"), `require("node:fs").writeFileSync(process.env.TOWER_MUTATION_REPORT,
    JSON.stringify({ files: { "counter.cjs": { mutants: [{ status: "Killed" }] } } }));`);
  await page.locator('#advanced-validation').evaluate(node=>node.open=true);
  await page.locator("#mutation-option").check();
  await page.evaluate(() => {
    const courier = document.querySelector("#courier");
    const animate = courier.animate.bind(courier);
    window.__deliveries = [];
    courier.animate = (...args) => {
      window.__deliveries.push({
        from: courier.dataset.from,
        to: courier.dataset.to,
      });
      return animate(...args);
    };
  });
  await page.locator("#start-workflow").click();
  await page.locator("#design-approval-status").filter({ hasText: "이대로 적용" }).waitFor();
  assert.equal(await page.locator('[data-node="design"]').getAttribute("data-state"), "waiting");
  assert.equal(await page.locator('[data-node="complete"]').getAttribute("data-state"), "idle");
  assert.equal(await page.locator("#mission-graph [data-task]").count(), 3);
  await page.locator("#mission-primary").filter({ hasText: "UI 시안 열기" }).waitFor();
  await page.locator("#design-delivery").filter({ hasText: "UI를 확인해보세요!" }).waitFor();
  await page.waitForFunction(() => window.__deliveries.some((entry) => entry.from === "gpt" && entry.to === "design"));
  await page.screenshot({ path: join(artifacts, "design-delivery.png") });
  assert.equal((await page.evaluate((id) => window.tower.workflow(id), projectId)).value.tasks.every((task) => task.status === "pending"), true);
  await page.locator("#mission-primary").click();
  await page.locator('#layout-preview').waitFor();
  assert.match(await page.locator('#layout-preview').innerText(),/이미지 API 호출 없음/);
  assert.equal((await application.evaluate(()=>globalThis.designPrompts)).length,0);
  await page.screenshot({path:join(artifacts,'layout-preview.png')});
  checks.push('Default UI approval uses a text layout with zero image API calls; an explicit image request converts it to an image preview');
  await page.locator('#generate-image').click();
  await page.locator("#generated-image").waitFor();
  const draft = (await page.evaluate((id) => window.tower.workflow(id), projectId)).value;
  await page.locator("#back-to-controller").click();
  await page.locator("#sidebar-images").click();
  assert.equal(await page.locator("#sidebar-images").getAttribute("aria-pressed"), "true");
  await page.locator("#image-provider").selectOption("gemini");
  await page.locator("#connections[open]").waitFor();
  await page.locator("#gemini-auth-status").filter({ hasText: "Google 연결됨" }).waitFor();
  await page.locator("#finish-connections").click();
  await page.locator("#image-prompt").fill("시간 숫자를 더 크게");
  await page.locator("#generate-image").click();
  await page.waitForFunction(() => document.querySelector("#image-prompt").value === "");
  const waiting = (await page.evaluate((id) => window.tower.workflow(id), projectId)).value;
  assert.notEqual(waiting.design.artifactId, draft.design.artifactId);
  assert.equal(waiting.design.provider, "gemini");
  assert.ok(waiting.tasks.every((task) => task.status === "pending"));
  await page.locator("#back-to-controller").click();
  await page.locator("#planner-input").fill("시안 수정: 검은 배경을 밝게 변경");
  await page.locator("#start-workflow").click();
  await page.locator("#images-view").waitFor();
  const revised = (await page.evaluate((id) => window.tower.workflow(id), projectId)).value;
  assert.equal(revised.design.status, "ready");
  assert.notEqual(revised.design.artifactId, waiting.design.artifactId);
  const prompts = await application.evaluate(() => globalThis.designPrompts);
  assert.match(prompts[0].prompt, /Default visual direction/);
  assert.deepEqual(prompts.slice(1).map((row) => row.provider), ["gemini", "gemini"]);
  for (const row of prompts.slice(1)) assert.doesNotMatch(row.prompt, /Default visual direction/);
  assert.match(prompts[2].prompt, /검은 배경을 밝게 변경/);
  await page.locator("#back-to-controller").click();
  await page.locator("#planner-input").fill("이대로 적용");
  await page.locator("#start-workflow").click();
  checks.push("Automatic design generation pauses all workers until approval in the controller chat");
  await page
    .locator("#project-state")
    .filter({ hasText: "전체 완료" })
    .waitFor({ timeout: 60000 });
  let run = (await page.evaluate((id) => window.tower.workflow(id), projectId))
    .value;
  assert.equal(run.round, 1);
  assert.equal(run.validation.passed, true);
  await openWorkflow(page);
  await page.locator('[data-node="complete"][data-state="done"]').waitFor();
  await page.locator('#mission-graph [data-task="logic"]').click();
  assert.equal(await page.locator('body').getAttribute("data-mission-panel"), "grok");
  await page.locator("#desk-popup-task").filter({ hasText: "counter.cjs" }).waitFor();
  assert.equal(await page.locator(".planner").isVisible(), true);
  assert.equal(await page.locator('[data-agent-panel="grok"]').isVisible(), true);
  await openAgent(page,"gpt");
  assert.equal(await page.locator("#agent-session-content .planner").count(),1);
  await page.locator("#planner-input").fill("A draft stays in the same controller session");
  await closeAgent(page);
  assert.equal(await page.locator("#planner-input").inputValue(),"A draft stays in the same controller session");
  await page.locator("#planner-input").fill("");
  await page.locator("#mission-primary").click();
  await page.locator("#test-report-dialog[open]").waitFor();
  await page.locator("#close-test-report").click();
  checks.push("Workflow task nodes open the owning AI with changed files; controller popup shares the same history and draft; completion opens actual validation");
  await openWorkflow(page);
  assert.equal(run.mutation.counts.Killed, 1);
  assert.match(await page.locator("#mutation-summary").innerText(), /1개 탐지/);
  checks.push("Standalone mutation option runs only after green baseline and renders its result in the inspector");
  await page.locator("#work-usage-summary").filter({ hasText: "호출" }).waitFor();
  await page.locator("#open-checkpoints").click();
  await page.locator("#checkpoints-dialog").waitFor();
  const checkpoint = page.locator("#checkpoint-select");
  assert.ok(await checkpoint.locator("option").count() > 1);
  await checkpoint.selectOption({ index: 1 });
  await page.locator("#checkpoint-preview").filter({ hasText: /복원|삭제/ }).waitFor();
  await page.locator("#close-checkpoints").click();
  checks.push("Work usage and persisted checkpoint previews are accessible in the desktop UI");
  assert.equal(
    run.testing.result.cases.filter((row) => row.status === "passed").length,
    2,
  );
  assert.equal(
    await readFile(join(root, "counter.cjs"), "utf8"),
    "exports.value=2;",
  );
  assert.match(await page.locator("#gpt-progress").innerText(), /TAP version/);
  assert.match(await page.locator("#testing-cases").innerText(), /✓ T1/);
  checks.push(
    "QA writes real Node tests, streams TAP, detects a fixture defect, repairs the original owner and reruns the original tests",
  );
  // Couriers intentionally pause behind Workflow/agent dialogs. Fast macOS
  // runners can finish the fixture before the first queued delivery is shown.
  await closeWorkflow(page);
  await page.waitForFunction(() => window.__deliveries.some(event => event.from === 'gpt' && event.to === 'grok'), null, {timeout:15000});
  assert.ok(
    (await page.evaluate(() => window.__deliveries)).some(
      (event) => event.from === "gpt" && event.to === "grok",
    ),
  );
  await openWorkflow(page);
  await page.locator(".mascot-motion-toggle").click();
  assert.equal(await page.locator("#courier").isHidden(), true);
  await page.locator(".mascot-motion-toggle").click();
  checks.push(
    "Actual workflow handoff animates the parcel between panels; motion-off immediately hides it",
  );
  await page.locator("#show-test-report").click();
  await page.locator("#test-report-dialog[open]").waitFor();
  assert.match(
    await page.locator("#test-report-content").innerText(),
    /T1: passed/,
  );
  assert.match(
    await page.locator("#test-report-content").innerText(),
    /Load counter.cjs/,
  );
  await page.locator("#close-test-report").click();
  assert.equal(
    (await page.locator("#planner-events .code-preview").count()) > 0,
    true,
  );
  checks.push(
    "Code previews, actual results and reproducible test steps are visible and persistent",
  );
  const firstConversation = await page
    .locator(".conversation-row.selected")
    .getAttribute("data-conversation");
  await openAgent(page,"grok");
  await page.locator("#grok-input").fill("Explain this counter");
  await page.locator("#grok-input").press("Enter");
  await page
    .locator("#grok-events")
    .filter({ hasText: "Fixture answer for grok" })
    .waitFor();
  await openAgent(page,"claude");
  await page.locator("#claude-input").fill("Explain the screen");
  await page.locator("#claude-input").press("Enter");
  await page
    .locator("#claude-events")
    .filter({ hasText: "Fixture answer for claude" })
    .waitFor();
  assert.equal(
    (await application.evaluate(() => globalThis.__chatInputs)).every(
      (row) => row.history.length === 0,
    ),
    true,
  );
  checks.push(
    "Each worker has a real provider-backed question path with separate scoped history",
  );
  await closeAgent(page);
  await page.locator("#controller-mode").selectOption("question");
  await page.locator("#planner-input").fill("Wait for cancellation");
  await page.locator("#planner-input").press("Enter");
  await page.locator("#stop-controller-chat").waitFor({ state: "visible" });
  await page.locator("#stop-controller-chat").click();
  await page
    .locator("#planner-events")
    .filter({ hasText: "응답을 중지했습니다." })
    .waitFor();
  assert.equal(
    (await page.evaluate((id) => window.tower.workflow(id), projectId)).value
      .id,
    run.id,
  );
  checks.push(
    "Controller question mode cancels its own response without launching or altering a completed workflow",
  );
  const usage = {
    checkedAt: new Date().toISOString(),
    providers: {
      gpt: {
        state: "unsupported",
        meters: [],
        remainingPercent: null,
        message: "fixture direct GPT",
      },
      claude: {
        state: "available",
        remainingPercent: 43,
        meters: [
          { id: "session", remainingPercent: 96 },
          { id: "weekly_all", remainingPercent: 43 },
        ],
        message: "fixture dual windows",
      },
      grok: {
        state: "unsupported",
        meters: [],
        remainingPercent: null,
        message: "fixture no numeric quota",
      },
      codex: {
        state: "available",
        remainingPercent: 43,
        meters: [
          { id: "primary", windowMinutes: 300, remainingPercent: 96 },
          { id: "secondary", windowMinutes: 10080, remainingPercent: 43 },
        ],
        message: "fixture native Codex",
      },
    },
  };
  await application.evaluate(
    ({ BrowserWindow }, usage) =>
      BrowserWindow.getAllWindows()[0].webContents.send("tower:event", {
        type: "usage",
        usage,
      }),
    usage,
  );
  await page.locator("#quota-gpt").filter({ hasText: "96%/43%" }).waitFor();
  assert.equal(await page.locator("#quota-claude").innerText(), "96%/43%");
  checks.push(
    "5-hour and weekly quotas display separately as 96%/43%, never minimum-only",
  );
  await page.locator("#new-conversation").click();
  await page
    .locator("#conversation-title")
    .filter({ hasText: "새 대화" })
    .waitFor();
  assert.equal(
    await page.locator("#planner-events .terminal-entry").count(),
    0,
  );
  assert.equal(await page.locator("#grok-events .terminal-entry").count(), 0);
  await page
    .locator('.conversation-row[data-conversation="' + firstConversation + '"]')
    .click();
  await page
    .locator("#conversation-title")
    .filter({ hasText: "Fixture timer with QA" })
    .waitFor();
  await openAgent(page,"grok");
  await page
    .locator("#grok-events")
    .filter({ hasText: "Explain this counter" })
    .waitFor();
  await closeAgent(page);
  checks.push(
    "New conversation is empty; selecting folder conversation restores messages and its own run/test result",
  );
  await page.locator("#sidebar-file-search").fill("does-not-exist");
  assert.equal(await page.locator(".conversation-row").count(), 0);
  await page.locator("#sidebar-file-search").fill("");
  await page.locator(".conversation-row.selected").waitFor();
  checks.push("Left sidebar searches conversations rather than files");
  await page.locator("#open-settings").click();
  await page.locator("#max-repair-rounds").fill("4");
  await page.locator("#save-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await page.evaluate(() => window.tower.preferences())).value
      .maxRepairRounds,
    4,
  );
  assert.equal(
    (await page.evaluate((id) => window.tower.workflow(id), projectId)).value
      .options.maxRepairRounds,
    2,
  );
  checks.push(
    "Settings changes apply to next work; completed run retains frozen configuration",
  );
  await page.locator("#open-roles").click();
  await page.locator("#agent-count").selectOption("2");
  for (const id of ["gpt", "grok"])
    await page.locator("#role-" + id).selectOption("gpt");
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".desk-agent-card").count(), 2);
  await page.locator("#open-roles").click();
  await page.locator("#agent-count").selectOption("4");
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".desk-agent-card").count(), 4);
  checks.push(
    "2/4 panel resizing retains multiple roles and independent chat composers",
  );
  await page.locator(".planner").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifacts, "workbench-controller-top.png"),
  });
  await openAgent(page,"grok");
  await page.screenshot({
    path: join(artifacts, "workbench-workers-below.png"),
  });
  await closeAgent(page);
  await page.locator(".planner").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "v07-controller.png") });
  for (const width of [1920, 1440, 900, 768, 414, 375, 320]) {
    await application.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(0, 0);
      win.setSize(width, 1000);
    }, width);
    const sizes = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(sizes.scroll <= sizes.width, "overflow at " + width);
    await openWorkflow(page);
    await page.locator("#mission-graph").waitFor();
    assert.ok(await page.locator("#mission-edges path").count() > 0);
    const flow = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(flow.scroll <= flow.width, "mission flow overflow at " + width);
    await closeWorkflow(page);
  }
  checks.push(
    "No horizontal overflow across 320,375,414,768,900,1440,1920px; large panels scroll vertically",
  );
  await application.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].setSize(1600,1100);});
  await checkDesktopFallback({application,page,artifacts,root:fallbackRoot,projectId,checks,openAgent,closeAgent});
  assert.deepEqual(errors, []);
  await application.close();
  page = await boot();
  await page.locator("#notification-bell").click();
  await page.locator("#notification-items").filter({hasText:"Persistent desktop notification fixture"}).waitFor();
  await page.locator("#close-notifications").click();
  checks.push("Notification history persists in the isolated OS-user app profile across a full restart");
  assert.equal(
    await page.locator("#settings-dialog").evaluate((node) => node.open),
    false,
  );
  await page.locator(".conversation-row.selected").waitFor();
  assert.equal(
    (await page.evaluate(() => window.tower.preferences())).value
      .maxRepairRounds,
    4,
  );
  await openAgent(page,"grok");
  await page
    .locator("#grok-events")
    .filter({ hasText: "Fixture answer for grok" })
    .waitFor();
  assert.equal(await page.locator(".desk-agent-card").count(), 4);
  checks.push(
    "Full restart restores project, selected conversation, worker replies, role count and preferences without repeated consent",
  );
  await openWorkflow(page);
  await page.locator("#restore-verified").click();
  await page.locator("#checkpoint-preview").filter({ hasText: "되돌릴 변경이 없습니다" }).waitFor();
  assert.equal(await page.locator("#confirm-checkpoint").isDisabled(), true);
  await page.locator("#close-checkpoints").click();
  await page.locator("#open-checkpoints").click();
  await page.locator("#checkpoint-select").selectOption({ index: 1 });
  await page.locator("#checkpoint-preview").filter({ hasText: /복원|삭제/ }).waitFor();
  await page.locator("#confirm-checkpoint").click();
  await page.locator("#checkpoints-dialog").waitFor({ state: "hidden" });
  const afterRollback = (await page.evaluate((id) => window.tower.workflow(id), projectId)).value;
  assert.equal(afterRollback.status, "awaiting_validation");
  assert.equal(afterRollback.validation.stale, true);
  assert.equal(await page.locator('[data-node="complete"]').getAttribute("data-state"), "idle");
  assert.equal(await page.locator('[data-node="testing"]').getAttribute("data-state"), "error");
  checks.push("Stable checkpoint card opens a safe preview and actual UI rollback invalidates prior verification");
  await closeWorkflow(page);
  const disposable = await page.evaluate((id) => window.tower.createConversation(id), projectId);
  await page.locator("#open-history").click();
  await page.locator("#history-select").selectOption(disposable.value.id);
  await page.locator("#history-archive").click();
  await page.locator(`#history-select option[value="${disposable.value.id}"]`).filter({ hasText: "보관됨" }).waitFor({ state: "attached" });
  await page.locator("#history-select").selectOption(disposable.value.id);
  await page.locator("#history-archive").click();
  await page.locator("#history-archive").filter({ hasText: "보관" }).waitFor();
  await page.locator("#history-select").selectOption(disposable.value.id);
  await page.locator("#history-delete").click();
  await page.locator("#history-confirm-text").waitFor();
  await page.locator("#history-delete").click();
  await page.locator(`#history-select option[value="${disposable.value.id}"]`).waitFor({ state: "detached" });
  await page.locator("#close-history").click();
  checks.push("History dialog archives, restores and confirms permanent conversation deletion");
  console.log(
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        providerInference:
          "explicit fixtures; actual coordinator and Node test processes",
        paidCalls: 0,
        profile,
        artifacts,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(artifacts, "smoke-v07-report.json"),
    JSON.stringify({ passed: checks.length, checks, errors }, null, 2),
  );
} catch (error) {
  await debugPage?.screenshot({path:join(artifacts,"desktop-failure.png"),fullPage:true}).catch(()=>{});
  console.error(JSON.stringify({pageErrors:errors}));
  throw error;
} finally {
  await application?.close().catch(() => {});
  if (await realpath(root) === root && root.startsWith(join(artifacts, "smoke-v07-workspace-")))
    await rm(root, { recursive: true });
  if (await realpath(profile).catch(() => null) === profile && profile.startsWith(join(artifacts, "smoke-v07-profile-")))
    await rm(profile, { recursive: true });
  if (await realpath(fallbackRoot).catch(()=>null)===fallbackRoot&&fallbackRoot.startsWith(join(artifacts,"smoke-fallback-workspace-")))await rm(fallbackRoot,{recursive:true});
}
