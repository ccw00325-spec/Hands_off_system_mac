import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  shell,
  session,
  dialog,
  Notification,
  nativeImage,
} from "electron";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Store, atomicWrite } from "./core/store.js";
import { NotificationInbox } from "./core/notifications.js";
import { ChatGPTAuth, PLAN_SCOPE } from "./core/oauth.js";
import { ImageService } from "./core/images.js";
import { ClaudeConnection } from "./core/claude.js";
import { Projects } from "./core/projects.js";
import { publicError } from "./core/http.js";
import { Workspace, digest } from "./core/workspace.js";
import { listCheckpoints, restoreCheckpoint, verifiedCheckpoint } from "./core/checkpoints.js";
import { Workflow } from "./core/workflow.js";
import { VisualCapture } from './core/visual-capture.js';
import { PreviewServers,DEFAULT_PREVIEW_PROFILES } from './core/preview-server.js';
import { VisualRegression } from './core/visual-regression.js';
import { Autopilot } from './core/autopilot.js';
import { GPTProvider, ClaudeProvider } from "./core/providers.js";
import { CursorProvider } from "./core/cursor-provider.js";
import { CursorConnection } from "./core/cursor.js";
import { GeminiConnection, GeminiProvider } from "./core/gemini.js";
import { RoleAssignments, roleProviders } from "./core/roles.js";
import { validateProject } from "./core/validation.js";
import { PersistentSession } from "./core/session.js";
import { BrowserOpener } from "./core/browser.js";
import { CodexUsage, UsageService } from "./core/usage.js";
import { CodexConnection } from "./core/codex.js";
import { validateModelId } from "./core/team.js";
import { Preferences } from "./core/preferences.js";
import { Conversations } from "./core/conversations.js";
import { AgentChat } from "./core/agent-chat.js";
import { AuxiliaryServices } from "./core/services.js";
import {ModelCatalog} from './core/model-catalog.js';
import { loadLocalWindow } from './core/window-loader.js';
import { Prerequisites, INSTALL_SITES, probeTool, requireTools } from './core/prerequisites.js';
import { CallQuota } from './core/call-quota.js';
import { InputNotifications, registerNotificationShortcut, NOTIFICATION_CLSID } from './core/input-notifications.js';
import { cacheWindowsIcon, windowsTaskbarDetails, windowsAppId } from './core/windows-branding.js';

const directory = dirname(fileURLToPath(import.meta.url));
let windowIcon = process.platform === 'win32'
  ? (app.isPackaged ? join(process.resourcesPath, 'app.ico') : join(directory, '../build/app.ico'))
  : join(directory, 'renderer/assets/mascot.png');
let taskbarDetails;
function applyTaskbarIcon(target) {
  if (process.platform === 'win32') {
    target.setIcon(windowIcon);
    target.setAppDetails(taskbarDetails);
  }
}
app.setName("CW_Handsoff_sys");
if (process.platform === 'win32') {
  app.setAppUserModelId(windowsAppId(app.isPackaged));
  app.setToastActivatorCLSID(NOTIFICATION_CLSID);
}
// Preserve the original install's sign-ins and projects when the product name changes.
if (app.isPackaged)
  app.setPath("userData", join(app.getPath("appData"), "agent-control-tower"));
const profileDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (app.isPackaged && profileDirectory && isAbsolute(profileDirectory))
  app.setPath("userData", resolve(profileDirectory));
if (!app.isPackaged) app.setPath("userData", resolve(directory, "../.runtime"));
// This switch is for local automated tests only and never changes production authentication.
if (!app.isPackaged && process.env.TOWER_TEST_USER_DATA)
  app.setPath("userData", resolve(process.env.TOWER_TEST_USER_DATA));
// Chromium storage follows the exact same OS-user/profile boundary as the app store.
app.setPath("sessionData", app.getPath("userData"));
if (app.isPackaged) {
  for (const name of ["no-sandbox", "disable-web-security", "allow-running-insecure-content", "remote-debugging-port", "remote-debugging-pipe"])
    app.commandLine.removeSwitch(name);
  app.enableSandbox();
}
const rendererPath = join(directory, "renderer/index.html");
const rendererURL = pathToFileURL(rendererPath).href;
let window,
  store,
  auth,
  images,
  claude,
  projects,
  workspace,
  workflow,
  grok,
  gemini,
  codex,
  roles,
  persistentSession,
  browser,
  usage;
let preferences, conversations, agentChat, auxiliary;
let prerequisites;
let previewServers,visualRegression,autopilot;
let visualCapture;
let prerequisiteScan, prerequisiteSource = 'codex';
let quota;
let inputNotifications;
let restorePromise;
let gptRestoreState = null;
let splash,
  catalog,
  startupPromise,
  mainRevealed = false,
  closingSplash = false;
let shuttingDown=false;
let mainDocumentLoaded = false, workspaceReady = false, revealScheduled = false;
const startupDiagnostics = [];
let diagnosticWrite = Promise.resolve();
let pendingDiagnostics = 0, flushingQuit = false;
function recordStartupFailure(stage, error, attempt) {
  // Deliberately exclude URLs, paths, exception messages and account data.
  startupDiagnostics.push({
    at: new Date().toISOString(), version: app.getVersion(), stage, attempt,
    code: ['ERR_FAILED', 'ERR_ABORTED', 'ERR_FILE_NOT_FOUND', 'ERR_ACCESS_DENIED', 'ENOENT', 'EACCES'].includes(error.code) ? error.code : 'OTHER',
    errno: Number.isInteger(error.errno) ? error.errno : null,
  });
  pendingDiagnostics++;
  diagnosticWrite = diagnosticWrite.catch(() => {}).then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true });
    await atomicWrite(join(app.getPath('userData'), 'startup-diagnostics.json'), JSON.stringify(startupDiagnostics.slice(-30), null, 2));
  }).catch(() => {}).finally(() => { pendingDiagnostics--; });
  return diagnosticWrite;
}
let startupPhase = {
  percent: 0,
  message: "상자 챙기고 출근하는 중…",
  detail: "AI들이 모이면 작업대를 열어드릴게요.",
  stage: "앱 시작 준비",
};
const splashPath = join(directory, "renderer/splash.html"),
  splashURL = pathToFileURL(splashPath).href;
function startupProgress(percent, message, detail, stage) {
  startupPhase = {
    percent: Math.max(startupPhase.percent, percent),
    message,
    detail,
    stage,
  };
  if (splash && !splash.isDestroyed())
    splash.webContents.send("startup:progress", startupPhase);
}
async function createSplash() {
  splash = new BrowserWindow({
    width: 520,
    height: 397,
    center: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: "Hands off 시작 준비",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    icon: windowIcon,
    webPreferences: {
      preload: join(directory, "startup-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      webSecurity: true,
      webviewTag: false,
    },
  });
  applyTaskbarIcon(splash);
  splash.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of ["will-navigate", "will-frame-navigate", "will-redirect"])
    splash.webContents.on(event, (event) => event.preventDefault());
  splash.on("closed", () => {
    if (!closingSplash&&!shuttingDown) app.quit();
  });
  ipcMain.on("startup:cancel", (event) => {
    if (
      splash &&
      !splash.isDestroyed() &&
      event.sender === splash.webContents &&
      event.senderFrame === splash.webContents.mainFrame &&
      event.senderFrame.url === splashURL
    )
      {shuttingDown=true;app.quit();}
  });
  const loaded = await loadLocalWindow(splash, splashPath, {
    isClosing: () => shuttingDown,
    onFailure: (error, attempt) => recordStartupFailure('splash', error, attempt),
  });
  if (!loaded || shuttingDown) return;
  splash.show();
  startupProgress(
    5,
    "상자 챙기고 출근하는 중…",
    "작업대 전원을 켜고 있어요.",
    "시작 준비",
  );
}
async function gptModelRows() {
  const current = await status();
  if (!current.gpt.connected)
    return {
      rows: [],
      state: "login_required",
      message: "GPT 계정을 연결하면 모델을 자동으로 준비합니다.",
    };
  if (current.gpt.source === "codex") return codex.models();
  const token = await auth.access();
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `GPT 모델 목록을 확인하지 못했습니다. HTTP ${response.status}`,
    );
  const body = await response.json();
  if (!Array.isArray(body.models))
    throw new Error("공식 로그인 모델 목록 형식을 확인하지 못했습니다.");
  return body.models
    .filter((row) => row.visibility === "list")
    .map((row) => ({ id: row.slug, name: row.display_name }));
}
function refreshCatalog(provider, invalidate = false) {
  if (!catalog) return Promise.resolve({});
  if (provider) {
    if (invalidate) catalog.invalidate(provider);
    return catalog.refresh(provider);
  }
  if (invalidate)
    for (const id of ["gpt", "claude", "grok", "gemini"])
      catalog.invalidate(id);
  return catalog.refreshAll();
}
async function prepareStartup() {
  startupProgress(
    15,
    "프로젝트 선반 정리 중…",
    "지난 작업과 설정을 제자리에 놓고 있어요.",
    "프로젝트·설정",
  );
  const [projectData, settings] = await Promise.all([
    projects.list(),
    preferences.get(),
  ]);
  if (shuttingDown) throw new Error('시작 준비를 취소했습니다.');
  startupProgress(
    28,
    "AI 출석부 확인 중…",
    "이 컴퓨터에 저장된 로그인만 확인해요.",
    "연결 상태",
  );
  let restored;
  try {
    restored = await restoreConnections();
  } catch {}
  const current = await status();
  restored ??= { ...current, browser: await browser.settings() };
  startupProgress(34, '공구함에 빠진 도구 찾는 중…', 'Git · Node.js · 선택한 AI와 격리 도구를 확인해요.', '설치 도구 확인');
  const tools = await scanPrerequisites(current, settings, projectData);
  if (shuttingDown) throw new Error('시작 준비를 취소했습니다.');
  startupProgress(
    40,
    "AI 모델들 집합 중…",
    "GPT · Claude · Cursor · Gemini의 선택지를 모으고 있어요.",
    "모델 목록",
  );
  const models = await catalog.refreshAll((done, total, provider) =>
    startupProgress(
      40 + Math.round((done / total) * 45),
      "AI 모델들 집합 중…",
      `${{ gpt: "GPT", claude: "Claude", grok: "Cursor", gemini: "Gemini" }[provider]} 확인 완료 · ${done}/${total}`,
      "모델 목록",
    ),
  );
  startupProgress(
    90,
    "상자는 챙겼고, 작업대 배치 중…",
    "목록과 화면을 연결하고 있어요.",
    "화면 준비",
  );
  return {
    projects: projectData,
    preferences: settings,
    restored,
    status: current,
    catalog: models,
    prerequisites: tools,
  };
}
async function scanPrerequisites(current, settings, projectData, projectId = projectData.activeId, requiredOnly = false) {
  prerequisiteSource = current.gpt?.source ?? prerequisiteSource;
  const active = projectId;
  const team = active ? await roles.getTeam(active) : [];
  const providers = team.length ? [...new Set(team.map(row => row.provider))].filter(id => id !== 'gpt' || prerequisiteSource !== 'api') : undefined;
  return { ...await prerequisites.scan({ ...current, gpt: current.codex }, { providers, executionBackend: settings.executionBackend, dockerImage:settings.dockerImage, requiredOnly }), projectId: active };
}
async function passivePrerequisites(tools, projectId, requiredOnly = false) {
  prerequisiteSource = (await store.read('execution-config', {})).gptSource ?? prerequisiteSource;
  if (!tools) {
    const team = await roles.getTeam(projectId);
    tools = [...new Set(team.map(row => row.provider))].filter(id => id !== 'gpt' || prerequisiteSource !== 'api');
  }
  const finders = { gpt: () => codex.find(), claude: () => claude.executable(), grok: () => grok.connection.find(), gemini: () => gemini.find() };
  const presence = Object.fromEntries(await Promise.all(Object.entries(finders).map(async ([id, find]) => {
    const before = prerequisites.current?.rows.find(row => row.id === id);
    if (id === 'gemini' && gemini.installing) return [id, { installed: false, installState: 'installing' }];
    if (!tools.includes(id)) return [id, { installed: before?.state !== 'missing', installState: before?.state ?? 'missing', version: before?.version }];
    const launch = await find();
    if (!launch) return [id, { installed: false, installState: 'missing' }];
    const check = await probeTool(typeof launch === 'string' ? launch : launch.executable, [...(launch.prefix ?? []), '--version'], 5000);
    return [id, { installed: true, installState: check.code === 0 ? 'ready' : 'unknown', version: check.output.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null }];
  })));
  const before = prerequisites.current;
  const result = await scanPrerequisites({ ...presence, codex: presence.gpt, gpt: { source: prerequisiteSource } }, await preferences.get(), await projects.list(), projectId, requiredOnly);
  for (const id of Object.keys(finders)) if (result.rows.some(row => row.id === id && row.state === 'ready') && before?.rows.find(row => row.id === id)?.state !== 'ready') {
    const connection = id === 'gpt' ? codex : id === 'grok' ? grok.connection : id === 'claude' ? claude : gemini;
    connection.cache = null; void refreshCatalog(id, true);
  }
  return result;
}
async function revealMain() {
  if (!startupPromise) throw new Error("시작 준비를 먼저 완료해야 합니다.");
  await startupPromise;
  workspaceReady = true;
  scheduleMainReveal();
  return true;
}
function scheduleMainReveal() {
  if (mainRevealed || revealScheduled || !mainDocumentLoaded || !workspaceReady || shuttingDown) return;
  revealScheduled = true;
  startupProgress(
    100,
    "준비 끝! 이제 일을 맡겨주세요.",
    "작업대 문을 열고 있어요.",
    "준비 완료",
  );
  setTimeout(async () => {
    revealScheduled = false;
    if (shuttingDown||!window || window.isDestroyed() || !mainDocumentLoaded || !workspaceReady) return;
    closingSplash = true;
    if(splash&&!splash.isDestroyed())splash.destroy();
    window.show();
    window.focus();
    mainRevealed = true;
    if (
      profileDirectory ||
      (!app.isPackaged && process.env.TOWER_TEST_USER_DATA)
    )
      await writeFile(
        join(app.getPath("userData"), "startup-ready.json"),
        JSON.stringify({
          version: app.getVersion(),
          percent: 100,
          mainVisible: window.isVisible(),
          splashClosed: !splash || splash.isDestroyed(),
          checkedAt: new Date().toISOString(),
        }),
      ).catch(() => {});
  }, 220);
}
const once = new Set();
const allowedLinks = {
  keys: "https://platform.openai.com/api-keys",
  geminiKeys: "https://aistudio.google.com/apikey",
  usage: "https://platform.openai.com/usage",
  chatgpt: "https://chatgpt.com/#settings",
  claude: "https://code.claude.com/docs/en/setup",
  gemini: "https://geminicli.com/docs/",
  grok: "https://cursor.com/docs/cli/installation",
  cursorUsage: "https://cursor.com/dashboard?tab=usage",
  codex: "https://learn.chatgpt.com/docs/cli",
  claudeUsage: "https://claude.ai/settings/usage",
  grokUsage: "https://grok.com/?_s=usage",
  gptUsage: "https://chatgpt.com/#settings",
  codexUsage: "https://chatgpt.com/codex/settings/usage",
};

function notify(value) {
  if (window && !window.isDestroyed())
    window.webContents.send("tower:event", value);
  if(!shuttingDown&&mainRevealed&&['auth','codex','claude','grok','gemini'].includes(value.type)&&value.state==='connected')
    void refreshCatalog(['auth','codex'].includes(value.type)?'gpt':value.type,true);
}
const requiredToolActions = new Set(['tower:check-work-tools','tower:start-workflow','tower:send-message','tower:answer-questions','tower:rerun-tests','tower:visual-retry','tower:generate-image','tower:revise-layout']);
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== rendererURL
    )
      return { ok: false, error: "허용되지 않은 요청입니다." };
    try {
      if (requiredToolActions.has(channel)) {
        projects.find(await projects.list(), args[0]);
        await requireTools(() => passivePrerequisites(undefined, args[0], true));
      }
      return { ok: true, value: await action(...args) };
    } catch (error) {
      return { ok: false, error: publicError(error), ...(error.code === 'PREREQUISITES_REQUIRED' ? { code: error.code, prerequisites: error.prerequisites } : {}) };
    }
  });
}
async function exclusive(key, action) {
  if (once.has(key)) throw new Error("작업이 이미 진행 중입니다.");
  once.add(key);
  try {
    return await action();
  } finally {
    once.delete(key);
  }
}
function generateDesignImage(id, prompt, provider = "gpt", signal) {
  return exclusive("image", async () => {
          const grant = await workspace.grant(id);
          const settings = await preferences.get();
          if (settings.apiBudgetUsd > 0 || settings.dailyApiBudgetUsd > 0) throw new Error('이미지 API 비용은 텍스트 단가로 제한할 수 없습니다. 이미지 생성 전 API 예산 설정을 검토하세요. 이미지에는 별도 일일 횟수 한도가 적용됩니다.');
          const ticket = await quota.admit({runId:'image-' + id, options:settings, image:true});
          try {
          const result = await images.generate(prompt, provider, signal);
          signal?.throwIfAborted();
          const name = `${randomUUID()}.png`;
          const saved = await workspace.write(
            id,
            `design/${name}`,
            result.buffer,
            { grantId: grant.grantId, newOnly: true },
          );
          const index = await store.read("image-index", {});
          index[id] = {
            artifactId: name,
            path: saved.path,
            grantId: grant.grantId,
          };
          await store.write("image-index", index);
          return {
            dataUrl: result.dataUrl,
            artifactId: name,
            projectId: id,
            path: saved.path,
            hash: saved.hash,
          };
          } finally { await quota.settle(ticket, 0); }
        });
}
async function executionOptions(id) {
  const current = await status();
  const settings = await preferences.get();
  const project = projects.find(await projects.list(), id);
  const delivery = await auxiliary.configuration(id, project);
  return {
    deliveryRevision: delivery?.revision,
    suggestRepositoryName:
      delivery?.github === true && !delivery.name && !delivery.resolvedName,
    maxRepairRounds: settings.maxRepairRounds,
    maxAgentCalls: settings.maxAgentCalls,
    maxDailyCalls: settings.maxDailyCalls,
    dailyApiBudgetUsd: settings.dailyApiBudgetUsd,
    maxOutputTokens: settings.maxOutputTokens,
    maxImageCallsPerDay: settings.maxImageCallsPerDay,
    executionBackend: settings.executionBackend,
    dockerImage: settings.dockerImage,
    designMode: settings.designMode,
    visualReview: settings.visualReview,
    maxConcurrentAgents: settings.maxConcurrentAgents,
    apiBudgetUsd: settings.apiBudgetUsd,
    apiInputRate: settings.apiInputRate,
    apiOutputRate: settings.apiOutputRate,
    apiRateModel: settings.apiRateModel,
    crossReview: true,
    autoFallback: true,
    designApproval: settings.designApproval,
    validationScript: settings.validationScript,
    allowExecution: settings.allowExecution && project.workspace?.executionApproved === true,
    unattended: settings.unattended,
    funContract: true,
    funEnabled: settings.funByDefault,
    engineeringGates: settings.engineeringGates,
    autopilotEnabled: settings.autopilotEnabled,
    previewProfiles: project.previewConfig?.profiles??DEFAULT_PREVIEW_PROFILES,
    team: await roles.getTeam(id),
    roles: await roles.get(id),
    gptSource: current.gpt.source,
    gptModel: current.gpt.modelId ?? "",
    grokRoute: await grok.selection(),
    geminiModel: (await store.read("gemini-model", {})).modelId ?? null,
  };
}
async function status() {
  const vault = await store.secrets();
  const accounts = (vault.accounts ?? []).map((account) => ({
    id: account.id,
    label: account.label,
    signedIn: Boolean(account.accessToken),
    planEnabled:
      Boolean(account.accessToken && account.scopes.includes(PLAN_SCOPE)) &&
      !(
        gptRestoreState?.accountId === account.id && !gptRestoreState.connected
      ),
    needsReconnect: Boolean(
      gptRestoreState?.accountId === account.id && !gptRestoreState.connected,
    ),
    active: account.id === vault.activeAccountId,
  }));
  const [claudeState, grokState, geminiState, codexState] = await Promise.all([
    claude.status(),
    grok.status(),
    gemini.status(),
    codex.status(),
  ]);
  const execution = await store.read("execution-config", {});
  const source =
    execution.gptSource ??
    (codexState.connected
      ? "codex"
      : accounts.some((account) => account.active && account.planEnabled)
        ? "api"
        : "codex");
  return {
    secureStorage: store.available(),
    appVersion: app.getVersion(),
    accounts,
    waiting: Boolean(auth.pending),
    image: {
      saved: Boolean(vault.imageKey),
      geminiSaved: Boolean(vault.geminiImageKey),
      verifiedAt: vault.imageKeyVerifiedAt ?? null,
    },
    claude: claudeState,
    grok: grokState,
    codex: codexState,
    gpt: {
      source,
      connected:
        source === "codex"
          ? codexState.connected
          : accounts.some((account) => account.active && account.planEnabled),
      modelId: execution.gptModel ?? null,
    },
    securityNotice: store.securityNotice,
    gemini: {
      ...geminiState,
      modelId: (await store.read("gemini-model", {})).modelId ?? null,
    },
    session: persistentSession.state(),
  };
}
async function restoreConnections() {
  if (restorePromise) return restorePromise;
  restorePromise = (async () => {
    const session = persistentSession.state();
    const vault = await store.secrets();
    const active = vault.accounts?.find(
      (account) => account.id === vault.activeAccountId,
    );
    let gpt = {
      configured: Boolean(active?.accessToken),
      connected: false,
      state: "not-connected",
    };
    if (active?.accessToken) {
      try {
        await auth.access({ forceRefresh: session.recheckRequired });
        gpt = { configured: true, connected: true, state: "connected" };
      } catch {
        gpt = {
          configured: true,
          connected: false,
          state: "verification-failed",
        };
      }
    }
    gptRestoreState = { ...gpt, accountId: active?.id };
    const [claudeState, grokState, geminiState, codexState] = await Promise.all(
      [
        claude.status({ force: true }),
        grok.status({ force: true }),
        gemini.status({ force: true }),
        codex.status({ force: true }),
      ],
    );
    const failed =
      gpt.state === "verification-failed" ||
      [claudeState, grokState, geminiState, codexState].some((item) =>
        ["unknown", "verification-failed"].includes(item.state),
      );
    if (!failed) await persistentSession.verified();
    const execution = await store.read("execution-config", {});
    if (execution.gptSource !== "api" && codexState.connected)
      gpt = {
        configured: true,
        connected: true,
        state: "connected",
        source: "codex",
      };
    return {
      gpt,
      codex: codexState,
      claude: claudeState,
      grok: grokState,
      gemini: geminiState,
      session: persistentSession.state(),
      browser: await browser.settings(),
    };
  })().finally(() => {
    restorePromise = null;
  });
  return restorePromise;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if(!mainRevealed&&splash&&!splash.isDestroyed()){splash.show();splash.focus();return;}
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      if (process.platform === 'win32') {
        try { windowIcon = await cacheWindowsIcon(windowIcon, app.getPath('userData')); }
        catch (error) { await recordStartupFailure('taskbar-icon', error, 1); }
        const executable = app.isPackaged ? process.env.PORTABLE_EXECUTABLE_FILE || process.execPath : process.execPath;
        taskbarDetails = windowsTaskbarDetails({ packaged: app.isPackaged, executable, appPath: app.getAppPath(), iconPath: windowIcon, profileDirectory });
        // Isolated verification profiles must not change the user's Start Menu.
        if (app.isPackaged && !profileDirectory) {
          try { await registerNotificationShortcut(app, shell, taskbarDetails); }
          catch (error) { await recordStartupFailure('taskbar-shortcut', error, 1); }
        }
      }
      await createSplash();
      if(shuttingDown)return;
      store = new Store(app.getPath("userData"), safeStorage);
      await store.init();
      prerequisites = new Prerequisites();
      quota = new CallQuota(store);
      if(shuttingDown)return;
      persistentSession = new PersistentSession(store);
      await persistentSession.open();
      if(shuttingDown)return;
      browser = new BrowserOpener(store, (url) => shell.openExternal(url));
      codex = new CodexConnection(store.directory, notify, {
        open: (url) => browser.open(url),
      });
      auth = new ChatGPTAuth(
        store,
        (url) => browser.open(url),
        (event) => {
          if (event.type === "auth" && event.state === "connected")
            gptRestoreState = null;
          notify(event);
        },
      );
      images = new ImageService(store);
      claude = new ClaudeConnection(notify);
      projects = new Projects(store);
      workspace = new Workspace(projects);
      auxiliary = new AuxiliaryServices(store, projects, workspace, notify);
      preferences = new Preferences(store);
      autopilot=new Autopilot(store,preferences);
      previewServers=new PreviewServers(workspace,store);
      previewServers.executionAllowed=async context=>{const live=await preferences.get();return live.allowExecution&&live.executionBackend===context.options.executionBackend&&(await workspace.grant(context.projectId,context.grantId)).executionApproved===true;};
      conversations = new Conversations(store, projects);
      grok = new CursorProvider(
        store,
        notify,
        new CursorConnection(notify, {
          cwd: store.directory,
          open: (url) => browser.open(url),
        }),
      );
      gemini = new GeminiConnection(store.directory, notify, {
        open: (url) => browser.open(url),
        developmentRoot: !app.isPackaged
          ? resolve(directory, "../.tools/gemini")
          : null,
      });
      roles = new RoleAssignments(projects);
      catalog=new ModelCatalog({
        gpt:gptModelRows,
        claude:async()=>({rows:['sonnet','opus','haiku'].map(id=>({id,name:`${id} · Claude CLI 공식 별칭`})),state:(await claude.status()).connected?'ready':'login_required',message:'Claude CLI 공식 모델 별칭입니다. 실제 사용 권한은 실행 시 확인합니다.'}),
        grok:async()=>(await grok.status()).connected?grok.models():{rows:[],state:'login_required',message:'Cursor 로그인 후 모델을 자동으로 준비합니다.'},
        gemini:async()=>(await gemini.status()).connected?gemini.models():{rows:[],state:'login_required',message:'Google 계정 연결 후 모델을 자동으로 준비합니다.'},
      },{notify:value=>notify({type:'model-catalog',catalog:value})});
      const codexUsage = new CodexUsage((response) =>
        usage?.pushCodex(response),
      );
      usage = new UsageService({
        claude,
        codex: codexUsage,
        cwd: app.getPath("userData"),
        notify,
        auto: !(!app.isPackaged && process.env.TOWER_TEST_USER_DATA),
      });
      workflow = new Workflow(
        workspace,
        roleProviders({
          gpt: new GPTProvider(auth, join(directory, "skills/fun.md"), codex),
          grok,
          claude: new ClaudeProvider(claude),
          gemini: new GeminiProvider(gemini),
        },{
          getUsage:()=>usage.snapshot(),
          confirmCursorUI:async ({signal,title})=>{
            signal?.throwIfAborted();
            if(!window||window.isDestroyed())return false;
            const result=await dialog.showMessageBox(window,{type:'warning',title:'Cursor UI 구현 확인',
              message:'Cursor에게 UI 구현·연결을 맡기는 것은 현재 권장 설정에서 추천하지 않습니다. 진행하시겠습니까?',
              detail:`작업: ${title??'UI 구현·연결'}\n승인한 시안을 화면으로 구현하는 역할입니다. GPT 또는 Claude로 변경할 수 있습니다. 취소하면 저장된 작업을 보존하고 멈춥니다.`,
              buttons:['취소','이번 작업에서 진행'],defaultId:0,cancelId:0,noLink:true});
            return result.response===1&&!signal?.aborted;
          },
        }),
        (event) => {
          notify(event);
          if (event.type === "workflow")
            void agentChat?.finishedRun(event.state).catch(() => {});
          if (event.type === 'workflow') void inputNotifications?.observe(event.state);
          if (event.type === "workflow" && event.state.status === "completed")
            void auxiliary.publish(event.state).catch(() => {});
        },
        async (context) =>
          validateProject(workspace, {
            ...context,
            options: {
              ...context.options,
              allowExecution:
                context.options.allowExecution === true &&
                (await preferences.get()).allowExecution &&
                (await workspace.grant(context.projectId, context.grantId)).executionApproved === true,
            },
          }),
      );
      workflow.designGenerator = generateDesignImage;
      visualCapture=new VisualCapture(workspace,store,{BrowserWindow,session,nativeImage});
      visualRegression=new VisualRegression(workspace,store,nativeImage);
      visualCapture.previewServers=previewServers;visualCapture.regression=visualRegression;workflow.autopilot=autopilot;
      workflow.visualCapture={
        capture:async context=>{const live=await preferences.get();if(context.options.executionBackend!==live.executionBackend)throw new Error('실행 위치가 바뀌었습니다. 현재 설정으로 다시 비교하세요.');return visualCapture.capture({...context,options:{...context.options,allowExecution:context.options.allowExecution&&live.allowExecution}});},
        stable:(...args)=>visualCapture.stable(...args),
      };
      workflow.quota = quota;
      agentChat = new AgentChat({
        conversations,
        workspace,
        workflow,
        optionsFor: async (id, conversationId) => {
          const active = workflow.runs.get(id)?.state;
          if (
            workflow.isActive(id) &&
            active?.options.conversationId === conversationId
          ) {
            const frozen = structuredClone(active.options);
            delete frozen.conversationHistory;
            return frozen;
          }
          return executionOptions(id);
        },
        notify,
      });
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      handle("tower:status", status);
      handle('tower:startup',async()=>{
        const first=!startupPromise;startupPromise??=prepareStartup();const boot=await startupPromise;
        if(first||!mainRevealed)return boot;
        const current=await status();
        return{projects:await projects.list(),preferences:await preferences.get(),restored:{...current,session:{...current.session,firstLaunch:false},browser:await browser.settings()},status:current,catalog:catalog.snapshot(),prerequisites:prerequisites.current};
      });
      handle('tower:prerequisites', async (options = {}) => {
        if (!options || typeof options !== 'object' || Array.isArray(options) || (options.passive !== undefined && typeof options.passive !== 'boolean')) throw new Error('설치 확인 요청을 확인하세요.');
        if (prerequisiteScan) return prerequisiteScan;
        const tools = options.tools ?? Object.keys(INSTALL_SITES);
        if (!Array.isArray(tools) || tools.length > 7 || tools.some(id => !Object.hasOwn(INSTALL_SITES, id))) throw new Error('설치 도구 목록을 확인하세요.');
        prerequisiteScan = (async () => {
        if (options.passive) return passivePrerequisites(tools);
        const previousReady=new Map((prerequisites.current?.rows??[]).map(row=>[row.id,row.state==='ready']));
        for (const connection of [codex, claude, grok, gemini]) { connection.cache = null; }
        const result = await scanPrerequisites(await status(), await preferences.get(), await projects.list());
        for(const row of result.rows)if(['gpt','claude','grok','gemini'].includes(row.id)&&row.state==='ready'&&previousReady.get(row.id)!==true)void refreshCatalog(row.id,true);
        return result;
        })().finally(() => { prerequisiteScan = null; });
        return prerequisiteScan;
      });
      handle('tower:check-work-tools', () => true);
      handle('tower:autopilot-default',value=>preferences.setAutopilotDefault(value));
      handle('tower:autopilot-rules',async id=>{projects.find(await projects.list(),id);return autopilot.list(id);});
      handle('tower:autopilot-remove',async(id,ruleId)=>{projects.find(await projects.list(),id);if(ruleId!==null&&(typeof ruleId!=='string'||ruleId.length>80))throw new Error('삭제할 규칙을 확인하세요.');await autopilot.remove(id,ruleId);return autopilot.list(id);});
      handle('tower:remember-design',async(id,runId,value)=>{const run=workflow.runs.get(id);if(run?.state.id!==runId||run.state.design?.status!=='ready'||typeof value!=='boolean')throw new Error('현재 준비된 시안의 반복 승인 옵션만 바꿀 수 있습니다.');run.state.rememberDesignApproval=value;await workflow.record(run,'system',value?'직접 승인할 동일 시안의 반복 승인 기억을 선택했습니다.':'시안 승인 기억을 해제했습니다.',{activity:'autopilot-preference'});return value;});
      handle('tower:preview-settings',async id=>{const info=await previewServers.allowed(id,await executionOptions(id));return{config:info.config,candidates:info.candidates,scripts:info.scripts,script:info.script,command:info.command,allowed:info.allowed};});
      handle('tower:preview-save',async(id,value)=>{
        const options=await executionOptions(id),info=await previewServers.fingerprint(id,options,value);
        const result=await dialog.showMessageBox(window,{type:'warning',title:'프로젝트 미리보기 승인',message:'이 프로젝트의 미리보기 설정을 저장할까요?',detail:`실행 위치: ${options.executionBackend}\n스크립트: ${info.script||'정적 화면 또는 기존 서버'}\n내용: ${info.command||'명령 실행 없음'}\n정리: ${info.cleanupCommand||'관리되는 foreground 프로세스 종료'}\n주소: ${info.config.url||'앱이 확보한 로컬 포트'}\n\n실행 동의가 있는 폴더의 비밀 파일을 제외한 복사본을 사용합니다. Docker는 별도 내부 네트워크·로컬 공개 포트로 격리하고 PC에서 대신 실행하지 않습니다. PC 직접 실행은 OS 사용자 권한입니다. 기존 서버 주소는 소스 연결이 미확인이라 자동 일치 완료로 처리하지 않습니다. 캡처·DOM·오류 로그가 UI 담당 AI에 전달됩니다.`,buttons:['취소','저장·미리보기 허용'],defaultId:0,cancelId:0,noLink:true});
        if(result.response!==1)return{saved:false};await previewServers.approve(id,await executionOptions(id),value,info.key);await visualCapture.authorize(id,info.grant.grantId,true);return{saved:true};
      });
      handle('tower:visual-baseline',async(id,runId,profileId)=>{
        const state=await workflow.current(id,runId);const result=await dialog.showMessageBox(window,{type:'question',title:'상태별 회귀 기준 승인',message:'현재 캡처를 이 화면 상태의 향후 비교 기준으로 사용할까요?',detail:'원본 시안 승인과 별개입니다. 같은 시안·뷰포트·동작·컴포넌트의 픽셀 변화와 배치 오차를 비교합니다. 현재 소스와 같은 캡처만 저장합니다.',buttons:['취소','이 상태를 기준으로 저장'],defaultId:0,cancelId:0,noLink:true});if(result.response!==1)return false;await visualRegression.approve(state,profileId);return true;
      });
      handle('tower:visual-state-image',async(id,runId,profileId)=>{
        const state=await workflow.current(id,runId),item=state?.visual?.evidence?.states?.find(row=>row.id===profileId),prefix=`.control-tower/runs/${state?.id}/visual/`;
        if(!item||!item.image.path.startsWith(prefix)||!/^\d+-[a-f0-9-]{36}-[\w-]+-state\.png$/.test(item.image.path.slice(prefix.length)))throw new Error('현재 작업의 화면 상태 캡처를 확인하세요.');
        const bytes=await workspace.read(id,item.image.path,{grantId:state.grantId,internal:true,maxBytes:16*1024*1024});if(digest(bytes)!==item.image.hash)throw new Error('상태 캡처가 변경됐습니다.');return'data:image/png;base64,'+bytes.toString('base64');
      });
      handle('tower:call-quota', () => quota.snapshot());
      handle('tower:visual-permission',async(id,runId,allow)=>{
        const state=await workflow.current(id,runId);if(!state?.visual)throw new Error('시안 비교 작업을 확인하세요.');
        if(allow!==undefined&&typeof allow!=='boolean')throw new Error('미리보기 동의 값을 확인하세요.');
        if(allow===true){
          const result=await dialog.showMessageBox(window,{type:'question',title:'UI 브라우저 미리보기 실행',message:'이 폴더의 UI를 격리된 브라우저에서 실행해 캡처할까요?',
            detail:'외부 통신·파일 접근·다운로드를 차단한 앱 내 브라우저에서 정적 HTML과 웹 스크립트를 실행합니다. 캡처와 화면 정보는 UI 담당 AI에게 전달됩니다. Docker 빌드·테스트 설정은 바뀌지 않습니다. 이 동의는 현재 PC 사용자와 현재 폴더에만 저장됩니다.',buttons:['취소','이 폴더의 미리보기 허용'],defaultId:0,cancelId:0,noLink:true});
          if(result.response!==1)return{allowed:false};
          await visualCapture.authorize(id,state.grantId,true);
        }else if(allow===false)await visualCapture.authorize(id,state.grantId,false);
        const permission=await visualCapture.permission(id,state.grantId,await executionOptions(id));return{allowed:permission.allowed,explicit:permission.explicit};
      });
      handle('tower:visual-retry',async(id,runId)=>workflow.retryVisual(id,runId,await executionOptions(id)));
      handle('tower:visual-evidence',async(id,runId)=>{
        const state=await workflow.current(id,runId),visual=state?.visual;
        if(!visual?.evidence)return{visual,images:null};
        const evidence=visual.evidence,prefix=`.control-tower/runs/${state.id}/visual/`;
        if(!evidence.actual.path.startsWith(prefix)||!/^\d+-[a-f0-9-]{36}-actual\.png$/.test(evidence.actual.path.slice(prefix.length)))throw new Error('시안 캡처 경로를 확인하세요.');
        const reference=await workspace.read(id,state.design.path,{grantId:state.grantId,maxBytes:16*1024*1024}),actual=await workspace.read(id,evidence.actual.path,{grantId:state.grantId,internal:true,maxBytes:16*1024*1024});
        if(digest(reference)!==state.design.hash||digest(actual)!==evidence.actual.hash)throw new Error('시안 또는 캡처가 바뀌었습니다.');
        const stale=(await workspace.snapshot(id)).hash!==evidence.sourceHash||!await visualCapture.stable(id,state.grantId,evidence);
        return{visual,stale,functional:state.validation,images:{reference:'data:image/png;base64,'+reference.toString('base64'),actual:'data:image/png;base64,'+actual.toString('base64')}};
      });
      handle('tower:revise-layout', (id, feedback, conversationId) => workflow.reviseDesign(id, feedback, 'gpt', conversationId, 'layout'));
      handle('tower:open-install-site', async id => {
        if (!Object.hasOwn(INSTALL_SITES, id)) throw new Error('허용되지 않은 설치 안내입니다.');
        await browser.open(INSTALL_SITES[id]);
        return true;
      });
      handle('tower:startup-state',()=>({...startupPhase,mainVisible:mainRevealed}));
      handle('tower:startup-ready',revealMain);
      handle('tower:startup-failed',message=>{if(shuttingDown)return;dialog.showErrorBox('Hands off 시작 오류',publicError(new Error(String(message).slice(0,1500))));app.quit();});
      handle('tower:model-catalog',()=>catalog.snapshot());
      handle('tower:refresh-model-catalog',()=>refreshCatalog(null,true));
      const inbox = new NotificationInbox(store);
      inputNotifications = new InputNotifications({ Notification,
        register: () => registerNotificationShortcut(app, shell, taskbarDetails),
        persist: value => inbox.add(value),
        activate: scope => {
          if (!window || window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.show(); window.focus();
          notify({ type: 'answer-required', ...scope });
        },
        failed: scope => notify({ type: 'system-notification-unavailable', ...scope }),
      });
      handle("tower:notifications", () => inbox.list());
      handle("tower:add-notification", (value) => inbox.add(value));
      handle("tower:remove-notification", (id) => inbox.remove(id));
      handle("tower:clear-notifications", () => inbox.clear());
      handle("tower:read-notifications", () => inbox.markRead());
      handle("tower:restore-connections", restoreConnections);
      handle("tower:activity", async () => {
        await persistentSession.touch();
        return persistentSession.state();
      });
      handle("tower:usage", () => usage.snapshot());
      handle("tower:refresh-usage", () => usage.refresh({ force: true }));
      handle("tower:poll-usage", () =>
        usage.auto ? usage.refresh() : usage.snapshot(),
      );
      handle("tower:browser-settings", () => browser.settings());
      handle("tower:set-browser", (preferred) =>
        browser.setPreferred(preferred),
      );
      handle("tower:login", (id) => exclusive("account", () => auth.start(id)));
      handle("tower:cancel-login", () => auth.cancel());
      handle("tower:select-account", (id) =>
        exclusive("account", async() => {const result=await auth.select(id);void refreshCatalog('gpt',true);return result;}),
      );
      handle("tower:sign-out", () =>
        exclusive("account", async() => {const result=await auth.signOut();void refreshCatalog('gpt',true);return result;}),
      );
      handle("tower:claude-login", (forceLogin) =>
        claude.connect({ forceLogin: forceLogin === true }),
      );
      handle("tower:grok-login", (forceLogin) =>
        grok.connect({ forceLogin: forceLogin === true }),
      );
      handle("tower:grok-models", () => catalog.rows('grok'));
      handle("tower:select-grok-model", async(modelId) => {validateModelId(modelId);if(!catalog.rows('grok').some(row=>row.id===modelId))throw new Error('준비된 Cursor 목록에서 모델을 선택하세요.');await store.write('cursor-model',{modelId});return grok.selection();});
      handle("tower:gemini-login", () => gemini.connect());
      handle("tower:codex-login", (force) =>
        codex.connect({ forceLogin: force === true }),
      );
      handle("tower:set-gpt-source", (source) =>
        exclusive("gpt-config", async () => {
          if (!["api", "codex"].includes(source))
            throw new Error("GPT 연결 경로가 올바르지 않습니다.");
          const value = await store.read("execution-config", {});
          value.gptSource = source;
          delete value.gptModel;
          await store.write("execution-config", value);
          void refreshCatalog('gpt',true);
          return value;
        }),
      );
      handle("tower:save-gpt-model", (model) =>
        exclusive("gpt-config", async () => {
          validateModelId(model);
          const value = await store.read("execution-config", {});
          value.gptModel = model;
          await store.write("execution-config", value);
          return value;
        }),
      );
      handle("tower:install-gemini", () => gemini.install());
      handle("tower:gemini-models", () => catalog.rows('gemini'));
      handle("tower:select-gemini-model", async (modelId) => {
        if (!catalog.rows('gemini').some((row) => row.id === modelId))
          throw new Error("현재 Gemini 목록의 모델을 선택하세요.");
        await store.write("gemini-model", { modelId });
        return { modelId };
      });
      handle("tower:roles", (id) => roles.get(id));
      handle("tower:set-roles", (id, value) => roles.set(id, value));
      handle("tower:team", (id) => roles.getTeam(id));
      handle('tower:confirm-cursor-ui-role', async () => {
        const answer=await dialog.showMessageBox(window,{type:'warning',title:'Cursor UI 역할 선택 확인',
          message:'Cursor에게 UI 구현·연결을 맡기는 것은 현재 권장 설정에서 추천하지 않습니다. 선택하시겠습니까?',
          detail:'기능 구현·디버깅·코드 검토·테스트는 선택할 수 있습니다. UI는 다른 AI를 사용할 수 있으며, 계속 선택해도 실제 작업 시의 승인 절차는 유지됩니다.',
          buttons:['취소','UI 역할 선택'],defaultId:0,cancelId:0,noLink:true});
        return answer.response===1;
      });
      handle("tower:set-team", (id, value) => roles.setTeam(id, value));
      const signIn = (provider) => {
        if (provider === "claude") return claude.login;
        if (provider === "grok") return grok.login;
        if (provider === "gemini") return gemini.login;
        if (provider === "codex") return codex.login;
        throw new Error("지원하지 않는 로그인 공급자입니다.");
      };
      handle("tower:login-browser", (provider) =>
        signIn(provider).openBrowser((url) => browser.open(url)),
      );
      handle("tower:login-code", (provider, code) =>
        signIn(provider).code(code),
      );
      handle("tower:cancel-cli-login", (provider) => signIn(provider).cancel());
      handle("tower:save-key", (key, provider) =>
        exclusive("key", () => images.saveKey(key, provider)),
      );
      handle("tower:remove-key", (provider) =>
        exclusive("key", () => images.removeKey(provider)),
      );
      handle("tower:projects", () => projects.list());
      handle("tower:services-status", (id) => auxiliary.status(id));
      handle("tower:services-result", (id) => auxiliary.result(id));
      handle("tower:services-answer", async (id, answer) => {
        const state = await workflow.current(id);
        if (
          !state ||
          !answer ||
          !(await auxiliary.publish(state, true, answer))
        )
          throw new Error("현재 완료 작업의 승인 요청을 다시 확인하세요.");
        return true;
      });
      handle("tower:services-login", (service) => auxiliary.login(service));
      handle("tower:services-save", (id, input) =>
        exclusive(`delivery:${id}`, () => auxiliary.save(id, input)),
      );
      handle("tower:services-retry", async (id) => {
        const prior = await auxiliary.result(id);
        if (!prior?.runId || !["failed", "running"].includes(prior.status))
          throw new Error("다시 시도할 릴리스가 없습니다.");
        const state = await workflow.current(id, prior.runId);
        if (state?.status !== "completed" || !state.options.deliveryRevision)
          throw new Error("자동 릴리스가 설정된 완료 작업이 필요합니다.");
        const config = await auxiliary.configuration(id);
        if (config?.revision !== state.options.deliveryRevision)
          throw new Error(
            "설정이 변경됐습니다. 새 작업을 완료한 뒤 배포하세요.",
          );
        if (!(await auxiliary.publish(state, true)) && auxiliary.running.has(id))
          throw new Error("릴리스가 이미 진행 중입니다.");
        return true;
      });
      handle("tower:preferences", () => preferences.get());
      handle("tower:project-execution", (id, approval) =>
        exclusive(`project-execution:${id}`, async () => {
          const grant = await workspace.grant(id);
          if (approval !== true && approval !== false) return grant.executionApproved === true;
          if (approval) {
            const result = await dialog.showMessageBox(window, {
              type: "warning",
              buttons: ["취소", "이 폴더의 코드 실행 허용"],
              defaultId: 0, cancelId: 0, noLink: true,
              title: "프로젝트 코드 실행 승인",
              message: "신뢰하는 프로젝트에서만 코드 실행을 허용하세요.",
              detail: `${grant.root}\n` + ((await preferences.get()).executionBackend === 'docker' ? 'Docker에서 비밀 파일을 제외한 복사본으로 실행합니다. 엔진·이미지가 준비되지 않으면 실행하지 않습니다.' : '현재 OS 사용자 권한으로 실행됩니다. 코드가 이 사용자의 파일을 읽거나 네트워크에 연결할 수 있습니다.'),
            });
            if (result.response !== 1) return grant.executionApproved === true;
          }
          const saved = await workspace.setExecutionApproval(id, grant.grantId, approval);
          if (!saved && workflow.runs.get(id)?.state.status === "validating") await workflow.stopAndWait(id);
          return saved;
        }),
      );
      handle("tower:save-preferences", (value) =>
        exclusive("preferences", async () => {
          const before = await preferences.get();
          if (value.executionBackend === 'host' && value.allowExecution && (before.executionBackend !== 'host' || !before.allowExecution)) {
            const consent = await dialog.showMessageBox(window, {type:'warning', title:'현재 PC에서 실행', message:'격리 없이 프로젝트 코드를 실행하시겠습니까?', detail:'신뢰하는 프로젝트에서만 사용하세요. 테스트·npm 스크립트가 현재 사용자의 파일·네트워크에 접근할 수 있습니다.', buttons:['취소', '위험을 이해하고 PC에서 실행'], defaultId:0, cancelId:0, noLink:true});
            if (consent.response !== 1) throw new Error('PC 직접 실행을 승인하지 않았습니다. Docker 격리를 사용할 수 있습니다.');
          }
          const saved = await preferences.save(value);
          if (!saved.allowExecution)
            for (const [id, run] of workflow.runs)
              if (run.state.status === "validating")
                await workflow.stopAndWait(id);
          return saved;
        }),
      );
      handle('tower:set-fun-default', enabled => exclusive('preferences', () => preferences.setFunDefault(enabled)));
      handle("tower:conversation-index", () => conversations.list());
      handle("tower:conversation-history", (id, conversationId, action) =>
        exclusive(`history:${id}`, async () => {
          if (workflow.isActive(id) || [...agentChat.sending, ...agentChat.pending.keys()].some((key) => key.startsWith(id + ":")))
            throw new Error("프로젝트 작업이나 AI 응답이 끝난 뒤 정리하세요.");
          return conversations.updateHistory(id, conversationId, action);
        }),
      );
      handle("tower:export-conversation", async (id, conversationId) => {
        const chat = await conversations.read(id, conversationId);
        const run = chat.runId ? await workflow.current(id, chat.runId) : null;
        const markdown = await conversations.markdown(id, conversationId, run);
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          defaultPath: "hands-off-" + chat.id.slice(0, 8) + ".md",
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (canceled || !filePath) return false;
        await writeFile(filePath, markdown, { encoding: "utf8", mode: 0o600 });
        return true;
      });
      handle("tower:create-conversation", (id) => conversations.create(id));
      handle("tower:conversation", async (id, conversationId) => {
        let conversation = conversationId
          ? await conversations.select(id, conversationId)
          : await conversations.active(id);
        if (!conversation) {
          const legacy = (await conversations.index()).managed?.[id] ? null : await workflow.current(id);
          conversation = await conversations.create(
            id,
            legacy?.request?.slice(0, 60) ?? "새 대화",
            legacy?.id ?? null,
          );
          if (legacy?.request) {
            await conversations.append(
              id,
              conversation.id,
              "gpt",
              "user",
              legacy.request,
            );
            conversation = await conversations.read(id, conversation.id);
          }
        }
        return {
          conversation,
          run: conversation.runId
            ? await workflow.current(id, conversation.runId)
            : null,
        };
      });
      handle(
        "tower:send-message",
        (id, conversationId, agentId, message, mode, mutation, imageProvider, funEnabled) =>
          exclusive(`chat:${id}:${agentId}`, () => {
            if (once.has(`history:${id}`)) throw new Error("대화 기록을 정리하는 중입니다.");
            return agentChat.send(id, conversationId, agentId, message, mode, mutation, imageProvider, funEnabled);
          }),
      );
      handle('tower:answer-questions', (id, conversationId, runId, batchId, answers, remember=[]) => exclusive(`chat:${id}:gpt`, async () => {
        if (once.has(`history:${id}`)) throw new Error('대화 기록을 정리하는 중입니다.');
        const conversation = await conversations.read(id, conversationId);
        if (conversation.runId !== runId) throw new Error('이 대화의 작업이 아닙니다.');
        const state = await workflow.answerQuestions(id, runId, batchId, answers, conversationId,remember);
        const resolved = state.options.questionAnswers.at(-1).answers;
        await conversations.append(id, conversationId, 'gpt', 'user',
          resolved.map(row => `${row.prompt}\n답변: ${row.value}`).join('\n\n'), 'complete');
        agentChat.changed(id, conversationId);
        return state;
      }));
      handle("tower:stop-message", (id, agentId) =>
        agentChat.cancel(id, agentId),
      );
      handle("tower:rerun-tests", async (id, runId) =>
        exclusive(`tests:${id}`, async () =>
          workflow.revalidate(id, runId, await preferences.get()),
        ),
      );
      handle("tower:test-report", async (id, runId) => {
        const run = await workflow.current(id, runId);
        if (!run?.testing) throw new Error("테스트 보고서가 없습니다.");
        return (
          await workspace.read(
            id,
            `.control-tower/runs/${run.id}/test-report.md`,
            { internal: true },
          )
        ).toString();
      });
      handle("tower:choose-project-folder", async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "새 프로젝트 폴더 선택",
          defaultPath: app.getPath("documents"),
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        return workspace.prepare(null, result.filePaths[0]);
      });
      handle("tower:create-project", (title) => projects.create(title));
      handle("tower:rename-project", (id, title) => projects.rename(id, title));
      handle("tower:select-project", (id) => projects.select(id));
      handle("tower:choose-folder", async (id) => {
        projects.find(await projects.list(), id);
        if (workflow.isActive(id))
          throw new Error("작업을 중지한 후 폴더를 변경하세요.");
        const result = await dialog.showOpenDialog(window, {
          title: "프로젝트 작업 폴더 선택",
          defaultPath: app.getPath("documents"),
          properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        return workspace.prepare(id, result.filePaths[0]);
      });
      handle("tower:grant-folder", async (id, ticket, consent) => {
        if (workflow.isActive(id))
          throw new Error("작업을 중지한 후 폴더를 변경하세요.");
        return workspace.consent(id, ticket, consent);
      });
      handle("tower:revoke-folder", async (id) => {
        for (const agentId of ["gpt", "grok", "claude", "reviewer"])
          agentChat.cancel(id, agentId);
        await workflow.stopAndWait(id);
        return workspace.serialize(id, () => projects.revoke(id));
      });
      handle("tower:folder-tree", (id) => workspace.tree(id));
      handle("tower:read-file", async (id, file) => {
        const buffer = await workspace.read(id, file);
        if (buffer.includes(0))
          throw new Error("바이너리 파일은 미리보기를 제공하지 않습니다.");
        return buffer.toString("utf8");
      });
      handle("tower:open-folder", async (id) => {
        const grant = await workspace.grant(id);
        const error = await shell.openPath(grant.root);
        if (error) throw new Error("폴더를 열지 못했습니다.");
      });
      handle("tower:start-workflow", async (id, options) => {
        if (once.has(`history:${id}`)) throw new Error("대화 기록을 정리하는 중입니다.");
        const conversation =
          (await conversations.active(id)) ?? (await conversations.create(id));
        return (
          await agentChat.send(
            id,
            conversation.id,
            "gpt",
            options.request,
            "work",
          )
        ).state;
      });
      handle("tower:verified-checkpoint", async (id) => {
        const grant = await workspace.grant(id);
        const marker = await verifiedCheckpoint(workspace, id, grant.grantId);
        return marker ? { at: marker.at } : null;
      });
      handle("tower:checkpoints", async (id) => {
        const grant = await workspace.grant(id);
        return listCheckpoints(workspace, id, grant.grantId);
      });
      handle("tower:restore-checkpoint", async (id, checkpoint, confirmation) => {
        if (workflow.isActive(id) || auxiliary.running.has(id))
          throw new Error("작업이나 배포가 끝난 후 복원하세요.");
        if (confirmation != null && (typeof confirmation !== "string" || !/^[0-9a-f]{64}$/.test(confirmation)))
          throw new Error("유효한 복원 미리보기가 필요합니다.");
        workflow.starting.add(id);
        auxiliary.running.add(id);
        try {
          const grant = await workspace.grant(id);
          const result = await restoreCheckpoint(workspace, id, grant.grantId, checkpoint, confirmation);
          if (result.id) await workflow.invalidateAfterRestore(id);
          return result;
        } finally {
          workflow.starting.delete(id);
          auxiliary.running.delete(id);
        }
      });
      handle("tower:workflow", (id) => workflow.current(id));
      handle("tower:stop-workflow", async (id) => {
        await workflow.stopAndWait(id);
        return workflow.current(id);
      });
      handle("tower:models", () => catalog.rows("gpt"));
      handle("tower:generate-image", (id, prompt, provider, conversationId) =>
        workflow.runs.get(id)?.state.status === "awaiting_design"
          ? workflow.reviseDesign(id, prompt, provider, conversationId, 'image')
          : generateDesignImage(id, prompt, provider),
      );
      handle("tower:latest-image", async (id) => {
        const project = projects.find(await projects.list(), id);
        const entry = (await store.read("image-index", {}))[id];
        if (entry && typeof entry === "object") {
          if (!project.workspace) return null;
          const grant = await workspace.grant(id);
          if (entry.grantId !== grant.grantId) return null;
          const buffer = await workspace.read(id, entry.path, {
            grantId: grant.grantId,
            maxBytes: 30000000,
          });
          return {
            dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
            artifactId: entry.artifactId,
            projectId: id,
            path: entry.path,
          };
        }
        const artifactId = entry;
        if (
          typeof artifactId !== "string" ||
          !/^[0-9a-f-]{36}\.png$/.test(artifactId)
        )
          return null;
        try {
          const buffer = await readFile(
            join(app.getPath("userData"), "artifacts", id, artifactId),
          );
          return {
            dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
            artifactId,
            projectId: id,
          };
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      });
      handle("tower:export-image", async (id, artifactId) => {
        projects.find(await projects.list(), id);
        if (
          typeof artifactId !== "string" ||
          !/^[0-9a-f-]{36}\.png$/.test(artifactId)
        )
          throw new Error("이미지를 찾지 못했습니다.");
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          defaultPath: "ui-mockup.png",
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (canceled || !filePath) return { saved: false };
        const entry = (await store.read("image-index", {}))[id];
        if (typeof entry === "object" && entry?.artifactId === artifactId) {
          const buffer = await workspace.read(id, entry.path, {
            grantId: entry.grantId,
            maxBytes: 30000000,
          });
          await writeFile(filePath, buffer);
        } else {
          const { copyFile } = await import("node:fs/promises");
          await copyFile(
            join(app.getPath("userData"), "artifacts", id, artifactId),
            filePath,
          );
        }
        return { saved: true };
      });
      handle("tower:open-link", async (key) => {
        if (!Object.hasOwn(allowedLinks, key))
          throw new Error("허용되지 않은 링크입니다.");
        await browser.open(allowedLinks[key]);
      });
      window = new BrowserWindow({
        width: 1600,
        height: 1040,
        minWidth: 900,
        minHeight: 700,
        title: "CW_Handsoff_sys",
        icon: windowIcon,
        backgroundColor: "#0b0d0f",
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: join(directory, "preload.cjs"),
          contextIsolation: true,
          devTools: !app.isPackaged,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
        },
      });
      applyTaskbarIcon(window);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      for (const navigation of ["will-navigate", "will-frame-navigate", "will-redirect"])
        window.webContents.on(navigation, (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      mainDocumentLoaded = await loadLocalWindow(window, rendererPath, {
        isClosing: () => shuttingDown,
        beforeAttempt: () => { mainDocumentLoaded = false; workspaceReady = false; },
        onRetry: (attempt) => startupProgress(startupPhase.percent, '작업대가 잠깐 삐끗했어요. 다시 여는 중…', `화면 불러오기 재시도 ${attempt}/3`, '화면 복구'),
        onFailure: (error, attempt) => recordStartupFailure('workspace', error, attempt),
      });
      scheduleMainReveal();
    } catch (error) {
      if(shuttingDown)return;
      await recordStartupFailure('startup', error, null);
      dialog.showErrorBox("CW_Handsoff_sys", "시작 화면을 준비하지 못했습니다. 앱을 다시 실행해 주세요.\n반복되면 startup-diagnostics.json의 오류 코드를 확인해 주세요.\n\n" + publicError(error));
      app.quit();
    }
  });
  app.on("before-quit", event => {
    shuttingDown=true;
    if (pendingDiagnostics) {
      event.preventDefault();
      if (!flushingQuit) {
        flushingQuit=true;
        void diagnosticWrite.finally(()=>{flushingQuit=false;app.quit();});
      }
    }
    auth?.cancel();
    claude?.cancel();
    grok?.cancel();
    gemini?.cancel();
    codex?.close();
    workflow?.stopAll();
    usage?.close();
    agentChat?.close();
  });
  app.on("window-all-closed", () => app.quit());
}
