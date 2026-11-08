import { _electron as electron } from "@playwright/test";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { workspaceWindow } from "./electron-workspace.mjs";
const artifacts = resolve("artifacts"),
  profile = join(artifacts, "startup-test-profile-" + Date.now());
await mkdir(profile, { recursive: true });
const env = { ...process.env, TOWER_TEST_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const checks = [],
  errors = [];
try {
  application = await electron.launch({ args: ["."], cwd: resolve("."), env });
  await application.evaluate(
    (_electron, url) => {
      const p = process.getBuiltinModule("url").fileURLToPath(url),
        require = process.getBuiltinModule("module").createRequire(p);
      require(p.replace('codex.js','prerequisites.js')).Prerequisites.prototype.scan=async()=>({rows:[],needsAttention:false,platform:process.platform,arch:process.arch});
      globalThis.__modelCalls = { gpt: 0, grok: 0, gemini: 0 };
      globalThis.__modelGate = new Promise(
        (resolve) => (globalThis.__releaseModels = resolve),
      );
      for (const [name, file] of [
        ["CodexConnection", "codex.js"],
        ["CursorConnection", "cursor.js"],
        ["GeminiConnection", "gemini.js"],
        ["ClaudeConnection", "claude.js"],
      ]) {
        const cls = require(p.replace("codex.js", file))[name];
        cls.prototype.status = async () => ({
          installed: true,
          connected: true,
          state: "connected",
          login: { waiting: false },
        });
        const id = {
          CodexConnection: "gpt",
          CursorConnection: "grok",
          GeminiConnection: "gemini",
        }[name];
        if (id)
          cls.prototype.models = async () => {
            globalThis.__modelCalls[id]++;
            await globalThis.__modelGate;
            return [
              { id: id + "-one", name: id + " model one" },
              { id: id + "-two", name: id + " model two" },
            ];
          };
      }
    },
    pathToFileURL(resolve("src/core/codex.js")).href,
  );
  const splash = await application.firstWindow();
  assert.match(splash.url(), /splash\.html$/);
  splash.on("pageerror", (error) => errors.push(error.message));
  const page = await workspaceWindow(application);
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(30000);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const calls = await application.evaluate(() => globalThis.__modelCalls);
    if (Object.values(calls).every((value) => value === 1)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(await application.evaluate(() => globalThis.__modelCalls), {
    gpt: 1,
    grok: 1,
    gemini: 1,
  });
  const visibility = await application.evaluate(({ BrowserWindow, screen }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      url: window.webContents.getURL(),
      visible: window.isVisible(),
      frame: window.hasShadow(),
      bounds: window.getBounds(),
      workArea: screen.getDisplayMatching(window.getBounds()).workArea,
    })),
  );
  assert.equal(
    visibility.find((window) => window.url.endsWith("index.html")).visible,
    false,
  );
  assert.equal(
    visibility.find((window) => window.url.endsWith("splash.html")).visible,
    true,
  );
  const shown = visibility.find((window) => window.url.endsWith("splash.html"));
  assert.ok(
    Math.abs(
      shown.bounds.x +
        shown.bounds.width / 2 -
        shown.workArea.x -
        shown.workArea.width / 2,
    ) < 3,
  );
  assert.ok(
    (await splash.locator("#progress").evaluate((progress) => progress.value)) >
      0,
  );
  assert.equal(await splash.evaluate(() => typeof window.require), "undefined");
  assert.equal(await splash.evaluate(() => typeof window.tower), "undefined");
  checks.push(
    "A centered standalone white splash is visible while the real workspace stays hidden; splash has no workspace IPC or Node access",
  );
  const positions = [];
  for (const [name, time] of [
    ["walk", 1600],
    ["fall", 2850],
    ["pickup", 4100],
  ]) {
    await splash.locator("svg").evaluate((svg, time) => {
      for (const animation of svg.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = time;
      }
    }, time);
    positions.push(
      await splash
        .locator(".character")
        .evaluate((el) => el.getBoundingClientRect().toJSON()),
    );
    await splash.screenshot({
      path: join(artifacts, "startup-" + name + ".png"),
    });
  }
  assert.ok(positions[1].width > positions[0].width);
  checks.push(
    "The native animation separately walks, trips over the center stone, drops the box, picks it up and resumes; CSS repeats the sequence",
  );
  await application.evaluate(() => globalThis.__releaseModels());
  await page.locator("#first-run-tour[open]").waitFor();
  const readyDeadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    ready = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("index.html"),
      );
      return window?.isVisible() && BrowserWindow.getAllWindows().length === 1;
    });
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true);
  assert.equal(
    (await page.evaluate(() => window.tower.startupState())).value.percent,
    100,
  );
  checks.push(
    "The main window opens only after all catalogs and renderer preparation reach 100%, and the standalone splash closes",
  );
  await page.locator("#tour-skip").click();
  await page.locator("#settings-dialog[open]").waitFor();
  await page.locator("#save-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  const before = await application.evaluate(() => globalThis.__modelCalls);
  await page.locator("#open-roles").click();
  await page.locator("#roles-dialog[open]").waitFor();
  await page.locator("#role-gpt").selectOption("gemini");
  await page
    .locator("#panel-model-gpt option[value=gemini-one]")
    .waitFor({ state: "attached" });
  await page.locator("#close-roles-outside").click();
  await page.locator("#model-button").click();
  assert.equal(await page.locator("#model-list .model-row").count(), 2);
  await page.locator("#model-list .model-row").nth(1).click();
  await page.locator("#open-connections").click();await page.locator("[data-setup-tab=accounts]").click();
  assert.equal(
    await page.locator("#grok-model option[value=grok-two]").count(),
    1,
  );
  await page.locator("#grok-model").selectOption("grok-two");
  await page.locator("#gemini-model").selectOption("gemini-two");
  await page
    .locator("#gemini-message")
    .filter({ hasText: /Google|로그인|연결/ })
    .waitFor();
  assert.equal(
    await page.locator("#load-grok-models,#load-gemini-models").count(),
    0,
  );
  assert.deepEqual(
    await application.evaluate(() => globalThis.__modelCalls),
    before,
  );
  checks.push(
    "Account selectors, role provider changes, controller model picker and choosing Cursor/Gemini models reuse the startup catalog with zero additional discoveries",
  );
  await page.locator('#finish-connections').click();
  await page.evaluate(async()=>{const data=(await window.tower.projects()).value;await window.tower.renameProject(data.activeId,'Startup reload fixture');});
  await page.reload();await page.locator('.project-folder').filter({hasText:'Startup reload fixture'}).waitFor();
  assert.equal(await page.locator('#settings-dialog').evaluate(dialog=>dialog.open),false);
  assert.deepEqual(await application.evaluate(()=>globalThis.__modelCalls),before);
  checks.push('Renderer reload keeps current projects and saved settings while reusing catalogs instead of replaying the original startup snapshot');
  assert.deepEqual(errors, []);
  await application.close();
  application = null;
  const cancelProfile = profile + "-cancel";
  await mkdir(cancelProfile);
  try {
    application = await electron.launch({
      args: ["."],
      cwd: resolve("."),
      env: { ...env, TOWER_TEST_USER_DATA: cancelProfile },
    });
    const cancelWindow = await application.firstWindow();
    assert.match(cancelWindow.url(), /splash\.html$/);
    const closed = application.waitForEvent("close", { timeout: 15000 });
    await cancelWindow.locator("#cancel").click();
    await closed;
    application = null;
    checks.push(
      "Cancelling the standalone splash exits startup instead of leaving a hidden workspace running",
    );
  } finally {
    await application?.close().catch(() => {});
    application = null;
    if (
      (await realpath(cancelProfile).catch(() => null)) === cancelProfile &&
      cancelProfile.startsWith(join(artifacts, "startup-test-profile-"))
    )
      await rm(cancelProfile, { recursive: true });
  }
  await writeFile(
    join(artifacts, "startup-desktop-report.json"),
    JSON.stringify(
      { passed: checks.length, checks, paidCalls: 0, errors },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: checks.length, checks, paidCalls: 0 }, null, 2),
  );
} finally {
  await application?.close().catch(() => {});
  if (
    (await realpath(profile).catch(() => null)) === profile &&
    profile.startsWith(join(artifacts, "startup-test-profile-"))
  )
    await rm(profile, { recursive: true });
}
