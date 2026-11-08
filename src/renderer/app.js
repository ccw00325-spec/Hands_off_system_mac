import {
  conversationTree,
  terminalFeed,
  testingInspector,
} from "./conversation-view.js";
import { fillPreferences, readPreferences } from "./settings-view.js";
import { quotaWindows } from "../core/quota-view.js";
import { createMascot } from "./mascot.js";
import { createMission } from "./mission-view.js";
import { createAgentDesk } from "./agent-desk.js";
import { createNotifications } from "./notification-view.js";
import { requestIssues, createRequestAlerts } from './request-readiness.js';
import { createPrerequisiteWatch } from './prerequisite-watch.js';
import { createVisualView } from './visual-view.js';
import { displayedTeam } from "./desk-state.js";
import {createGuide} from './guide.js';
import { createClarifications } from './clarification-view.js';
import { CAPABILITIES, SLOT_IDS, defaultTeam } from "../core/team.js";
import {
  renderTeamEditor,
  readTeamEditor,
  resizeEditor,
  refreshEditorModels,
  renderPanelTeam,
  renderInspector,
  renderSidebarProjects,
  renderSidebarFiles,
} from "./workbench.js";
const $ = (selector) => document.querySelector(selector);
let desk, notifications;
let funSaving = false;
let preparedCatalog={};
function applyModelCatalog(value){
  preparedCatalog=value??{};
  for(const [provider,selector,label]of [['gpt','#gpt-model','GPT 모델 선택'],['grok','#grok-model','Cursor 모델 선택'],['gemini','#gemini-model','Gemini 모델 선택']]){
    const select=$(selector),entry=preparedCatalog[provider],selected=select.value||connection?.[provider]?.modelId||'';
    select.replaceChildren(new Option(label,''),...(entry?.rows??[]).map(row=>new Option(row.name,row.id)));
    if((entry?.rows??[]).some(row=>row.id===selected))select.value=selected;
    const hint=$('#'+provider+'-catalog-state');if(hint)hint.textContent=entry?.message??'연결 후 모델을 자동으로 준비합니다.';
  }
  if($('#roles-dialog').open)refreshEditorModels(preparedCatalog);
  updateReadiness();
}
const mascot = createMascot($("#mascot-stage"));
const mission = createMission({ onAction: missionAction, onMode: () => renderAssignedRoles(), onSelect: (actor,taskId) => desk?.openAgent(actor,taskId) });
const api = window.tower;
let projectData,
  connection,
  editingProject = false,
  resultImage = null;
let generationProject = null;
let missionDelivery = null;
let folderTicket = null,
  linkedFolder = null,
  currentRun = null;
const ACTIVE_RUN = new Set([
  "planning",
  "awaiting_design",
  "building",
  "testing",
  "validating",
  "reviewing",
  "repairing",
  "final_review",
]);
const resultCache = new Map();
const visualView=createVisualView({api,call,projectId:()=>projectData?.activeId,currentRun:()=>currentRun,active:run=>ACTIVE_RUN.has(run?.status),notice:toast});
let usageData = null,
  usageProvider = "claude",
  restoring = false,
  lastActivity = 0;
const usageRunStates = new Map();
const AI_NAMES = {
  gpt: "GPT",
  grok: "Grok · Cursor",
  claude: "Claude",
  gemini: "Gemini",
};
const ROLE_LABELS = {
  gpt: "컨트롤 타워",
  grok: "작업 02",
  claude: "작업 03",
  reviewer: "작업 04",
};
let roleAssignments = null,
  rolesProjectId = null,
  rolesDialogProjectId = null,
  roleSaving = false;
let teamConfig = null;
let preferences = null,
  currentConversation = null,
  conversationIndex = null,
  conversationSerial = 0,
  autoQuestion = false;
const activeRuns = new Map(),
  pendingChats = new Map(),
  liveBuffers = new Map();
desk = createAgentDesk({ onAction: missionAction });
notifications = createNotifications(api, handleNotification);
createGuide(missionAction);
const clarificationUI = createClarifications({
  submit: (run, answers) => call(api.answerQuestions(run.projectId, run.options.conversationId, run.id, run.questionBatchId, answers)),
  changed: state => {
    activeRuns.set(state.projectId, state);
    if (state.projectId === projectData?.activeId && state.options.conversationId === currentConversation?.id) {
      renderWorkflow(state); void loadConversation(state.options.conversationId);
    }
  },
  error: () => {},
});

function toast(message, type = "") {
  notifications.push(message, type, { projectId: projectData?.activeId, conversationId: currentConversation?.id });
}
async function handleNotification(item) {
  try {
    if (item.projectId && item.projectId !== projectData?.activeId)
      renderProjects(await call(api.selectProject(item.projectId)));
    if (item.conversationId && item.conversationId !== currentConversation?.id)
      await loadConversation(item.conversationId);
    if (item.action === 'prerequisites') showPrerequisites(await call(api.prerequisites()));
    else if (item.action === 'questions') clarificationUI.open();
    else missionAction(item.action ?? "workflow");
  } catch (error) { toast(error.message,"error"); }
}
function currentDisplayTeam() { return displayedTeam(currentRun, teamConfig ?? [], currentConversation); }
async function call(promise) {
  const result = await promise;
  if (!result.ok) {
    if (result.code === 'PREREQUISITES_REQUIRED' && result.prerequisites) {
      const projectId = result.prerequisites.projectId ?? projectData?.activeId;
      if (projectId === projectData?.activeId) showPrerequisites(result.prerequisites);
      notifications.push(result.error, 'error', {action:'prerequisites',projectId});
      throw Object.assign(new Error(result.error), {notified:true});
    }
    throw new Error(result.error);
  }
  return result.value;
}
function message(selector, text, type = "") {
  $(selector).textContent = text;
  $(selector).className = `hint ${type}`;
}
function pill(selector, text, good = false) {
  $(selector).textContent = text;
  $(selector).className = `status-pill${good ? " connected" : ""}`;
}
async function busy(button, text, task) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = text;
  button.setAttribute("aria-busy", "true");
  try {
    return await task();
  } catch (error) {
    if (!error.notified) toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = previous;
    button.removeAttribute("aria-busy");
    if (button.id === "chatgpt-login" && connection) {
      button.disabled = connection.waiting || !connection.secureStorage;
      button.textContent = connection.waiting
        ? "브라우저에서 승인 대기 중…"
        : connection.accounts.length
          ? "다른 계정 연결 ↗"
          : "Continue with ChatGPT ↗";
    }
    updateReadiness();
  }
}
function openConnections() {
  if (!$("#connections").open) $("#connections").showModal();
}
function activeProject() {
  return projectData.items.find(
    (project) => project.id === projectData.activeId,
  );
}
function renderProjects(data) {
  projectData = data;
  roleAssignments = null;
  rolesProjectId = null;
  const roleProject = data.activeId;
  teamConfig = null;
  void call(api.team(roleProject))
    .then((value) => {
      if (projectData.activeId !== roleProject) return;
      teamConfig = value;
      roleAssignments = Object.fromEntries(
        value.map((agent) => [agent.id, agent.provider]),
      );
      rolesProjectId = roleProject;
      renderAssignedRoles();
      updateReadiness();
    })
    .catch((error) => toast(error.message, "error"));
  currentConversation = null;
  conversationSerial++;
  $("#conversation-title").textContent = "새 대화";
  void refreshConversationIndex();
  $("#project-select").replaceChildren(
    ...data.items.map((project) => new Option(project.title, project.id)),
  );
  $("#project-select").value = data.activeId;
  $("#project-title").textContent = activeProject().title;
  document.title = `${activeProject().title} — CW_Handsoff_sys`;
  resultImage = resultCache.get(data.activeId) ?? null;
  linkedFolder = null;
  currentRun = null;
  renderDesignDelivery();
  renderImage();
  void refreshWorkspace();
  void loadConversation();
  void call(api.servicesResult(roleProject))
    .then((result) => {
      if (projectData?.activeId === roleProject) renderDelivery(result);
    })
    .catch(() => {});
  const id = data.activeId;
  void refreshVerifiedCheckpoint(id);
  if (!resultImage)
    void call(api.latestImage(id))
      .then((result) => {
        if (result) resultCache.set(id, result);
        if (projectData.activeId === id && result) {
          resultImage = result;
          renderImage();
        }
      })
      .catch((error) => toast(error.message, "error"));
}
function renderImage() {
  const design = currentRun?.status === "awaiting_design" ? currentRun.design : null;
  const currentGenerating = generationProject === projectData?.activeId || ["pending", "generating"].includes(design?.status);
  const layout = design?.format === 'layout' && design.status === 'ready';
  $('#image-heading').textContent = layout ? '화면 구조 먼저 확인하기' : 'UI 시안 만들기';
  $('#design-provider-note').textContent = layout ? '이 구조안에는 이미지 API 키나 생성 비용이 필요하지 않습니다. 시각적인 시안이 필요할 때만 이미지 생성 버튼을 사용하세요.' : 'GPT 또는 Gemini 이미지 모델을 선택하세요. 생성 비용은 각 이미지 API 계정에서 처리됩니다.';
  $('#generate-image').classList.toggle('primary', !layout);
  $('#update-layout').classList.toggle('primary', layout);
  $('#layout-preview').hidden = !layout;
  $('#layout-preview').textContent = layout ? design.previewText : '';
  $('#update-layout').hidden = !design;
  const preview = design?.format === 'layout' ? null : !design || (design.status === "ready" && resultImage?.artifactId === design.artifactId)
    ? resultImage : null;
  $("#image-empty").hidden = Boolean(preview) || layout;
  $("#generated-image").hidden = !preview;
  $("#image-result").hidden = !preview;
  if (preview) {
    if ($("#generated-image").getAttribute("src") !== preview.dataUrl) $("#generated-image").src = preview.dataUrl;
  }
  else $("#generated-image").removeAttribute("src");
  $("#image-empty h3").textContent = currentGenerating
    ? "시안을 생성하고 있습니다…"
    : design?.status === "error" ? "시안을 만들지 못했습니다." : "시안을 이곳에서 확인합니다.";
  $("#image-empty p").textContent = currentGenerating
    ? "응답을 기다리고 있습니다. 완료 전까지 생성 완료로 표시하지 않습니다."
    : design?.status === "error" ? "API 키와 사용 내역을 확인한 뒤 다시 생성하세요." : "생성이 완료되면 현재 프로젝트에 저장됩니다.";
  $("#design-review-actions").hidden = !design;
  $("#design-review-hint").textContent = preview && design
    ? "마음에 들면 컨트롤 타워에서 ‘이대로 적용’을 보내세요. 수정할 부분은 아래에 적어 주세요."
    : "시안을 검토하고 승인하면 구현을 시작합니다.";
  $("#image-prompt").required = !design;
}
async function refreshStatus(prepared) {
  const status = prepared??await call(api.status());
  const previous=connection;
  connection = status;
  $("#app-version").textContent = `LOCAL / ${status.appVersion}`;
  const account = status.accounts.find((item) => item.active);
  const usable = account?.planEnabled === true;
  const gptUsable = status.gpt.connected;
  pill(
    "#gpt-status",
    usable ? "권한 승인됨" : account?.signedIn ? "사용 권한 필요" : "미연결",
    usable,
  );
  pill(
    "#auth-status",
    usable ? "권한 승인됨" : account?.signedIn ? "로그인만 완료" : "미연결",
    usable,
  );
  if (account?.needsReconnect) {
    pill("#gpt-status", "연결 재확인 필요");
    pill("#auth-status", "연결 재확인 필요");
  }
  pill(
    "#key-status",
    status.image.saved ? "등록됨" : "미등록",
    status.image.saved,
  );
  pill(
    "#claude-status",
    status.claude.connected ? "CLI 로그인됨" : "미연결",
    status.claude.connected,
  );
  pill(
    "#claude-auth-status",
    status.claude.connected
      ? "CLI 로그인됨"
      : status.claude.installed
        ? "미연결"
        : "설치 필요",
    status.claude.connected,
  );
  $("#claude-login").disabled =
    !status.claude.installed || status.claude.connected;
  $("#connection-count").textContent =
    Number(gptUsable) +
    Number(status.claude.connected) +
    Number(status.grok.connected) +
    Number(status.gemini.connected);
  $("#connection-dot").classList.toggle(
    "mint-dot",
    gptUsable ||
      status.claude.connected ||
      status.grok.connected ||
      status.gemini.connected,
  );
  $("#storage-status").textContent = status.secureStorage
    ? "✓ OS 암호화 저장소 사용 가능"
    : "OS 보안 저장소 사용 불가 · 저장 차단";
  $("#save-key").disabled = !status.secureStorage;
  $("#chatgpt-login").disabled = status.waiting || !status.secureStorage;
  $("#chatgpt-login").textContent = status.waiting
    ? "브라우저에서 승인 대기 중…"
    : status.accounts.length
      ? "다른 계정 연결 ↗"
      : "Continue with ChatGPT ↗";
  $("#cancel-login").hidden = !status.waiting;
  renderImageKey(status);
  $("#image-key-hint").textContent = imageKeyReady(selectedImageProvider(), status)
    ? "✓ 이미지 API 키 등록됨 · 실제 생성 시 권한과 잔액 확인"
    : "연결 설정에서 이미지 API 키를 등록하세요.";
  $("#generate-image").disabled =
    !imageKeyReady(selectedImageProvider(), status) || !linkedFolder || generationProject !== null;
  $("#account-section").hidden = !status.accounts.length;
  const previousSelected = $("#account-select").value;
  $("#account-select").replaceChildren(
    ...status.accounts.map(
      (item) =>
        new Option(
          `${item.label}${item.active ? " · 현재 사용" : ""}${!item.signedIn ? " · 재로그인 필요" : ""}`,
          item.id,
        ),
    ),
  );
  $("#account-select").value = status.accounts.some(
    (item) => item.id === previousSelected,
  )
    ? previousSelected
    : (account?.id ?? status.accounts[0]?.id ?? "");
  $("#sign-out").disabled = !account?.signedIn;
  if (account)
    message(
      "#auth-message",
      usable
        ? `${account.label} · 사용 권한을 승인했습니다. 실제 모델 접근은 요청 시 확인됩니다.`
        : "로그인은 완료됐지만 AI 사용 권한은 없습니다. 다시 승인으로 권한을 연결하세요.",
      usable ? "success" : "",
    );
  if (status.claude.connected)
    message(
      "#claude-message",
      "터미널에 저장된 Claude 로그인을 사용합니다. 다시 로그인할 필요가 없습니다.",
      "success",
    );
  else if (!status.claude.installed)
    message(
      "#claude-message",
      "공식 Claude Code를 설치한 후 상태 다시 확인을 눌러주세요.",
    );
  pill(
    "#grok-auth-status",
    status.grok.connected
      ? "CLI 로그인됨"
      : status.grok.installed
        ? "연결 필요"
        : "설치 필요",
    status.grok.connected,
  );
  if (!currentRun)
    pill(
      "#grok-status",
      status.grok.connected
        ? "CLI 로그인됨"
        : status.grok.installed
          ? "연결 확인 필요"
          : "설치 필요",
      status.grok.connected,
    );
  if (status.grok.connected)
    message(
      "#grok-message",
      "기존 Cursor Agent 로그인을 사용합니다. 아래에서 Grok 모델을 선택하세요. Cursor 계정의 이용 한도가 적용됩니다.",
      "success",
    );
  else if (!status.grok.installed)
    message(
      "#grok-message",
      "Cursor Agent CLI 설치 후 연결하기를 누르세요. 로그인 정보는 원본 CLI가 보관합니다.",
    );
  const model = status.grok.modelId;
  if (
    model &&
    !Array.from($("#grok-model").options).some(
      (option) => option.value === model,
    )
  )
    $("#grok-model").append(new Option(model, model));
  $("#grok-model").value = model ?? "";
  $("#grok-model-label").textContent = model ?? "Grok 모델 미선택";
  for (const provider of ["claude", "grok"])
    renderCliLogin(provider, status[provider]);
  renderGeminiConnection(status.gemini);
  renderAssignedRoles();
  renderCodexConnection(status);
  if(!prepared)applyModelCatalog(await call(api.modelCatalog()));
  if(!prepared&&previous&&['gpt','claude','grok','gemini'].some(id=>previous[id]?.connected!==status[id]?.connected)&&!Object.values(preparedCatalog).some(entry=>entry.state==='loading'))
    void call(api.refreshModelCatalog()).then(applyModelCatalog).catch(()=>{});
  if (usageData) renderUsage(usageData);
  updateReadiness();
  return status;
}

$("#open-connections").addEventListener("click", openConnections);
document
  .querySelectorAll(".connect-shortcut")
  .forEach((button) => button.addEventListener("click", openConnections));
$("#close-connections").addEventListener("click", () => {
  $("#connections").close();
  $("#image-api-key").value = "";
});
$("#finish-connections").addEventListener("click", () => {
  $("#connections").close();
  $("#image-api-key").value = "";
});
$("#connections").addEventListener("close", () => {
  $("#image-api-key").value = "";
});
document
  .querySelectorAll("[data-link]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      busy(button, "여는 중…", () => call(api.openLink(button.dataset.link))),
    ),
  );

async function login(accountId) {
  try {
    await call(api.login(accountId));
    message(
      "#auth-message",
      "공식 브라우저에서 로그인하고 사용 권한을 승인하세요. 비밀번호는 이 앱에 입력하지 않습니다.",
    );
  } catch (error) {
    message("#auth-message", error.message, "error");
  }
  await refreshStatus();
}
$("#chatgpt-login").addEventListener("click", () =>
  busy($("#chatgpt-login"), "로그인 준비 중…", () => login()),
);
$("#reauth-account").addEventListener("click", () =>
  busy($("#reauth-account"), "준비 중…", () =>
    login($("#account-select").value),
  ),
);
$("#cancel-login").addEventListener("click", () =>
  busy($("#cancel-login"), "취소 중…", async () => {
    await call(api.cancelLogin());
    await refreshStatus();
  }),
);
$("#use-account").addEventListener("click", () =>
  busy($("#use-account"), "전환 중…", async () => {
    await call(api.selectAccount($("#account-select").value));
    await refreshStatus();
    toast("선택한 계정으로 전환했습니다.", "success");
  }),
);
$("#sign-out").addEventListener("click", () =>
  busy($("#sign-out"), "로그아웃 중…", async () => {
    const result = await call(api.signOut());
    await refreshStatus();
    message(
      "#auth-message",
      result.message,
      result.remoteRevoked ? "" : "error",
    );
    toast(result.message);
  }),
);
$("#claude-login").addEventListener("click", () => connectCLI("claude"));
$("#grok-login").addEventListener("click", () => connectCLI("grok", true));
$("#refresh-status").addEventListener("click", () =>
  busy($("#refresh-status"), "확인 중…", async () => {
    await restoreSavedConnections();
    await refreshStatus();
    applyModelCatalog(await call(api.refreshModelCatalog()));
    toast("공식 CLI와 저장된 연결 상태를 확인했습니다.");
  }),
);

$("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#image-api-key");
  const provider = imageKeyProvider;
  const key = input.value;
  input.value = "";
  input.removeAttribute("aria-invalid");
  await busy($("#save-key"), "키 확인 중…", async () => {
    try {
      const result = await call(api.saveKey(key, provider));
      await refreshStatus();
      message("#key-message", result.message, "success");
      toast("이미지 API 키를 암호화해 저장했습니다.", "success");
    } catch (error) {
      input.setAttribute("aria-invalid", "true");
      message("#key-message", error.message, "error");
    }
  });
});
$("#delete-key").addEventListener("click", () =>
  busy($("#delete-key"), "삭제 중…", async () => {
    await call(api.removeKey(imageKeyProvider));
    await refreshStatus();
    message("#key-message", "저장된 API 키를 삭제했습니다.");
  }),
);

$("#project-select").addEventListener("change", async (event) => {
  try {
    renderProjects(await call(api.selectProject(event.target.value)));
  } catch (error) {
    toast(error.message, "error");
  }
});
$("#new-project").addEventListener("click", () =>
  busy($("#new-project"), "폴더 선택 중…", async () => {
    const ticket = await call(api.chooseProjectFolder());
    if (!ticket) return;
    folderTicket = ticket;
    $("#consent-path").textContent = ticket.root;
    $("#folder-consent-check").checked = false;
    $("#folder-consent").showModal();
  }),
);
$("#edit-title").addEventListener("click", () => {
  editingProject = true;
  $("#project-dialog-title").textContent = "프로젝트 제목 편집";
  $("#project-name").value = activeProject().title;
  $("#project-dialog").showModal();
});
$("#cancel-project").addEventListener("click", () =>
  $("#project-dialog").close(),
);
$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await busy($("#project-form button[type=submit]"), "저장 중…", async () => {
    const name = $("#project-name").value;
    renderProjects(
      await call(
        editingProject
          ? api.renameProject(projectData.activeId, name)
          : api.createProject(name),
      ),
    );
    $("#project-dialog").close();
    toast(
      editingProject
        ? "프로젝트 제목을 변경했습니다."
        : "프로젝트를 만들었습니다.",
      "success",
    );
  });
});

let imageKeyProvider = "gpt";
const selectedImageProvider = () => $("#image-provider").value;
const imageKeyReady = (provider = selectedImageProvider(), status = connection) =>
  Boolean(provider === "gemini" ? status?.image?.geminiSaved : status?.image?.saved);
function renderImageKey(status) {
  const isGemini = imageKeyProvider === "gemini";
  $("#image-key-model").textContent = isGemini ? "GEMINI FLASH IMAGE" : "GPT IMAGE 2";
  $("#image-key-label").textContent = isGemini ? "Google AI Studio API 키" : "OpenAI 개인 API 키";
  $("#image-api-key").placeholder = imageKeyReady(imageKeyProvider, status) ? "교체하려면 새 키를 입력하세요." : isGemini ? "AIza…" : "sk-…";
  $("#image-key-link").dataset.link = isGemini ? "geminiKeys" : "keys";
  $("#image-usage-link").hidden = isGemini;
  $("#delete-key").hidden = !imageKeyReady(imageKeyProvider, status);
  pill("#key-status", imageKeyReady(imageKeyProvider, status) ? "등록됨" : "미등록", imageKeyReady(imageKeyProvider, status));
}
function connectImageProvider() {
  imageKeyProvider = selectedImageProvider();
  openConnections();
  renderImageKey(connection);
  $("#key-form").scrollIntoView({ block: "center" });
  $("#image-api-key").focus();
  if (imageKeyProvider === "gemini" && connection?.gemini?.installed && !connection.gemini.connected)
    $("#gemini-login").click();
}
$("#connect-image-provider").addEventListener("click", connectImageProvider);
$("#image-provider").addEventListener("change", () => {
  $("#image-model-label").textContent = selectedImageProvider() === "gemini" ? "Gemini Flash Image" : "GPT Image 2";
  $("#image-key-hint").textContent = imageKeyReady() ? "이미지 API 키 등록됨" : "이미지 API 키를 연결하세요.";
  updateReadiness();
  if (!imageKeyReady() || (selectedImageProvider() === "gemini" && connection?.gemini?.installed && !connection.gemini.connected))
    connectImageProvider();
});
function openDesign() {
  view(true);
  $("#image-heading").focus();
}
$("#open-run-design").addEventListener("click", openDesign);
function view(images) {
  $("#workspace-view").hidden = images;
  $("#images-view").hidden = !images;
  $("#tab-workspace").classList.toggle("selected", !images);
  $("#tab-workspace").setAttribute("aria-selected", String(!images));
  $("#tab-images").classList.toggle("selected", images);
  $("#tab-images").setAttribute("aria-selected", String(images));
  $("#sidebar-images").setAttribute("aria-pressed", String(images));
  renderDesignDelivery();
  mission.redraw();
}
function renderDesignDelivery() {
  const ready = currentRun?.status === "awaiting_design" && currentRun.design?.status === "ready";
  const show = ready && $("#images-view").hidden;
  $("#design-delivery").hidden = !show;
  if (show) $("#sidebar-images").setAttribute("aria-describedby", "design-delivery");
  else $("#sidebar-images").removeAttribute("aria-describedby");
}
$("#tab-workspace").addEventListener("click", () => view(false));
$("#tab-images").addEventListener("click", openDesign);
$("#sidebar-images").addEventListener("click", openDesign);
$("#back-to-controller").addEventListener("click", () => {
  view(false);
  $("#planner-input").focus();
});
$("#image-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (generationProject !== null) return;
  const projectId = projectData.activeId;
  generationProject = projectId;
  renderImage();
  await busy($("#generate-image"), "시안 생성 중…", async () => {
    try {
      const result = await call(
        api.generateImage(projectId, $("#image-prompt").value, selectedImageProvider(), currentConversation?.id),
      );
      resultCache.set(projectId, result);
      if (projectData.activeId === projectId) {
        resultImage = result;
        $("#image-prompt").value = "";
      }
      toast("시안 생성이 완료되어 요청한 프로젝트에 저장했습니다.", "success");
    } finally {
      generationProject = null;
      renderImage();
    }
  });
  $("#generate-image").disabled = !imageKeyReady() || !linkedFolder;
  await refreshWorkspace();
});
$("#export-image").addEventListener("click", () =>
  busy($("#export-image"), "내보내는 중…", async () => {
    if (!resultImage) return;
    const result = await call(
      api.exportImage(resultImage.projectId, resultImage.artifactId),
    );
    if (result.saved) toast("PNG 파일을 내보냈습니다.", "success");
  }),
);
$("#model-button").addEventListener("click", () =>
  busy($("#model-button"), "목록 확인 중…", async () => {
    if (currentDisplayTeam()[0]?.provider !== "gpt" || currentDisplayTeam()[0]?.modelId) {
      await openRoles("gpt");
      return;
    }
    $("#model-list").replaceChildren();
    $("#models-dialog").showModal();
    const rows = preparedCatalog.gpt?.rows??[];
    const selected = $("#gpt-model").value;
    $("#gpt-model").replaceChildren(
      new Option("GPT 모델 선택", ""),
      ...rows.map((item) => new Option(item.name, item.id)),
    );
    if (rows.some((item) => item.id === selected))
      $("#gpt-model").value = selected;
    for (const item of rows) {
      const row = document.createElement("button");
      row.className = "model-row";
      const name = document.createElement("strong");
      name.textContent = item.name;
      const slug = document.createElement("span");
      slug.textContent = item.id;
      row.append(name, slug);
      $("#model-list").append(row);
      row.addEventListener("click", () => {
        $("#gpt-model").value = item.id;
        void call(api.saveGptModel(item.id)).catch((error) =>
          toast(error.message, "error"),
        );
        $("#models-dialog").close();
        updateReadiness();
      });
    }
    if (!rows.length)
      $("#model-list").textContent = preparedCatalog.gpt?.message??"이 계정에서 표시할 모델이 없습니다. 계정 연결을 확인하세요.";
  }),
);
$("#close-models").addEventListener("click", () => $("#models-dialog").close());

async function initialize() {
  void notifications.init().catch(() => { $("#footer-status").textContent = "알림 기록을 읽지 못했습니다. 작업 기능은 계속 사용할 수 있습니다."; });
  if (!api) {
    toast(
      "이 화면은 데스크톱 앱에서 실행하세요. 프로젝트 폴더에서 npm start를 실행하면 됩니다.",
      "error",
    );
  } else {
    api.onEvent(async (event) => {
      if (event.type === 'answer-required') { await handleNotification(event); return; }
      if (event.type === 'system-notification-unavailable') {
        toast('시스템 알림을 표시하지 못했습니다. 종 아이콘의 ‘질문에 답변하기’를 이용하고 OS 알림 설정을 확인해 주세요.');
        return;
      }
      if(event.type==='model-catalog'){applyModelCatalog(event.catalog);return;}
      if (event.type === "service-login") {
        if ($("#services-dialog").open)
          void loadServices().then(() => {
            $("#services-result").textContent = event.connected
              ? `${event.service} CLI 계정 연결을 확인했습니다.`
              : "로그인을 확인하지 못했습니다. 공식 CLI 또는 브라우저에서 로그인 상태를 확인하세요.";
          }).catch((error) => toast(error.message, "error"));
        return;
      }
      if (
        event.type === "delivery" &&
        event.projectId === projectData?.activeId
      ) {
        renderDelivery(event.result);
        toast(
          event.result.message,
          event.result.status === "failed" ? "error" : "",
        );
        return;
      }
      if (event.type === "chat-updated") {
        if (event.projectId === projectData?.activeId) {
          for (const id of SLOT_IDS) pendingChats.delete(id);
          for (const job of event.pending ?? [])
            pendingChats.set(job.agentId, job.conversationId);
          if (event.conversationId === currentConversation?.id)
            void loadConversation(currentConversation.id);
          else void refreshConversationIndex();
        }
        return;
      }
      if (event.type === "agent-routing") {
        if (event.projectId === projectData?.activeId && event.conversationId === currentConversation?.id)
          void loadConversation(currentConversation.id);
        return;
      }
      if (event.type === "agent-progress") {
        if (
          event.projectId !== projectData?.activeId ||
          event.conversationId !== currentConversation?.id
        )
          return;
        const key = currentConversation.id + ":" + event.agentId;
        liveBuffers.set(
          key,
          (liveBuffers.get(key) ?? "") +
            (event.command ? "$ " + event.command + "\n" : "") +
            event.text,
        );
        const box = $("#" + event.agentId + "-progress");
        if (box) {
          box.textContent = liveBuffers.get(key).slice(-20000);
          box.hidden = false;
          box.scrollTop = box.scrollHeight;
        }
        return;
      }
      if (event.type === "usage") {
        renderUsage(event.usage);
        return;
      }
      if (event.type === "workflow") {
        notifications.observe(event.state,{projectId:event.projectId,conversationId:event.state.options.conversationId});
        const prior = activeRuns.get(event.projectId);
        if (event.projectId === projectData?.activeId && event.state.testFailure?.status === "intervention" &&
            (prior?.id !== event.state.id || prior.testFailure?.status !== "intervention"))
          toast(event.state.testFailure.reason, "error");
        activeRuns.set(event.projectId, event.state);
        if (
          event.projectId === projectData?.activeId &&
          (!event.state.options.conversationId ||
            event.state.options.conversationId === currentConversation?.id)
        ) {
          if (
            currentConversation &&
            event.state.options.conversationId === currentConversation.id
          )
            currentConversation.runId = event.state.id;
          renderWorkflow(event.state);
        } else updateReadiness();
        const previous = usageRunStates.get(event.projectId);
        usageRunStates.set(event.projectId, event.state.status);
        if (
          previous !== event.state.status &&
          !ACTIVE_RUN.has(event.state.status)
        ) {
          void refreshUsage(false);
          if (event.projectId === projectData?.activeId) {
            void refreshWorkspace();
            void refreshVerifiedCheckpoint(event.projectId);
          }
        }
        return;
      }
      if (event.type === "auth")
        message(
          "#auth-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
      if (event.type === "codex")
        message(
          "#codex-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
      if (event.type === "claude")
        message(
          "#claude-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
      if (event.type === "grok")
        message(
          "#grok-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
      if (["claude", "grok"].includes(event.type) && event.login)
        renderCliLogin(event.type, {
          ...connection?.[event.type],
          login: event.login,
        });
      if (event.type === "gemini") {
        message(
          "#gemini-message",
          event.message,
          event.state === "error" ? "error" : "",
        );
        if (event.login)
          renderGeminiConnection({ ...connection?.gemini, login: event.login });
      }
      if (event.state !== "waiting")
        toast(event.message, event.state === "error" ? "error" : "");
      try {
        await refreshStatus();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    try {
      const boot=await call(api.startup());
      renderProjects(boot.projects);
      preferences=boot.preferences;fillPreferences(preferences);
      const restored=await restoreSavedConnections(boot.restored);
      const status=await refreshStatus(boot.status);
      applyModelCatalog(boot.catalog);
      const setupNeeded = boot.prerequisites?.needsAttention && !sessionStorage.getItem('tower-setup-seen');
      if (setupNeeded) {
        showPrerequisites(boot.prerequisites);
        notifications.push('설치를 진행해주세요. 필수 프로그램이 모두 준비되어야 AI 작업과 앱 제작을 시작할 수 있습니다.', 'error', {action:'prerequisites',projectId:projectData?.activeId});
      }
      else if (!localStorage.getItem("tower-tour-v1")) startTour();
      else if (!preferences.onboardingComplete) $("#settings-dialog").showModal();
      $("#footer-status").textContent =
        "연결 상태 확인 완료 · 프로젝트 폴더에서 작업합니다.";
      const connected =
        status.gpt.connected ||
        status.claude.connected ||
        status.grok.connected ||
        status.gemini.connected;
      if (
        preferences.onboardingComplete &&
        !$("#settings-dialog").open &&
        !$("#first-run-tour").open && !$('#prerequisites-dialog').open &&
        restored?.session.firstLaunch &&
        !connected
      )
        openConnections();
      renderUsage(await call(api.usage()));
      void refreshUsage(false);
      await refreshWorkspace();
      await loadConversation();
      await document.fonts.ready;
      await call(api.startupReady());
    } catch (error) {
      toast(error.message, "error");
      void api.startupFailed(error.message);
    }
  }
}

function updateReadiness() {
  const active =
    ACTIVE_RUN.has(activeRuns.get(projectData?.activeId)?.status) ||
    ACTIVE_RUN.has(currentRun?.status);
  const mode = $("#controller-mode");
  mode.querySelector("option[value=work]").disabled = active;
  if (active && mode.value === "work") {
    mode.value = "question";
    autoQuestion = true;
  } else if (!active && autoQuestion) {
    mode.value = "work";
    autoQuestion = false;
  }
  const question = mode.value === "question";
  $("#mutation-option").disabled = question;
  $('#fun-option').disabled = question || funSaving;
  const needed = controllerIssues().filter(issue => issue.action !== 'input').map(issue => issue.label);
  const pending = pendingChats.get("gpt") === currentConversation?.id;
  $("#stop-controller-chat").hidden = !pending;
  $("#start-workflow").disabled = pending || funSaving;
  $('#start-workflow').title = needed.length ? '누르면 먼저 필요한 설정을 안내합니다.' : '';
  const request = $("#planner-input").value.trim();
  const reviewingDesign = currentRun?.status === "awaiting_design";
  $("#start-workflow").textContent = reviewingDesign && /^이대로\s*적용[.!]?$/.test(request) ? "시안 승인 ↑"
    : reviewingDesign && /^시안\s*수정\s*[:：]/.test(request) ? "시안 수정 요청 ↑"
    : question ? "질문 보내기 ↑" : "작업 요청 ↑";
  $("#stop-workflow").hidden = !active;
  $("#choose-folder").disabled = active;
  $("#restore-verified").disabled = active;
  $("#open-checkpoints").disabled = active;
  $("#run-readiness").textContent = needed.length
    ? "연결 필요: " + [...new Set(needed)].join(" · ")
    : currentRun?.status === "awaiting_design"
      ? "UI 시안 검토 · ‘이대로 적용’으로 승인하거나 ‘시안 수정: 바꿀 내용’을 입력하세요."
      : active
      ? "작업 진행 중 · 질문은 별도 응답합니다. 변경 요청은 작업 종료 또는 중지 후 보낼 수 있습니다."
      : question
        ? "프로젝트 질문 · 파일을 수정하지 않는 대화입니다."
        : "Enter로 작업 요청 · 실행 권한과 자동 수정은 우측 상단 설정에서 관리합니다.";
  $("#generate-image").disabled =
    !imageKeyReady() || !linkedFolder || generationProject !== null;
  refreshMission();
}
async function refreshWorkspace() {
  if (!projectData) return;
  const id = projectData.activeId;
  const project = activeProject();
  linkedFolder = null;
  if (!project.workspace) {
    $("#folder-path").textContent = "작업 폴더를 연결하세요.";
    pill("#folder-permission", "접근 동의 필요");
    for (const selector of ["#show-files", "#open-folder", "#revoke-folder"])
      $(selector).hidden = true;
    renderSidebarFiles(null, viewSidebarFile);
    renderWorkflow(null);
    updateReadiness();
    return;
  }
  $("#folder-path").textContent = project.workspace.root;
  $("#revoke-folder").hidden = false;
  try {
    const tree = await call(api.folderTree(id));
    if (projectData.activeId !== id) return;
    linkedFolder = tree;
    pill("#folder-permission", "읽기 · 생성 · 수정 동의됨", true);
    $("#show-files").hidden = false;
    $("#open-folder").hidden = false;
    $("#choose-folder").textContent = "폴더 변경";
    renderFileList(tree);
    const run = await call(api.workflow(id));
    if (projectData.activeId === id) {
      activeRuns.set(id, run);
      if (currentConversation) void loadConversation(currentConversation.id);
    }
  } catch (error) {
    if (projectData.activeId !== id) return;
    pill("#folder-permission", "접근 확인 필요");
    $("#show-files").hidden = true;
    $("#open-folder").hidden = true;
    toast(error.message, "error");
    renderWorkflow(null);
  }
  updateReadiness();
}
function renderFileList(tree) {
  renderSidebarFiles(tree, viewSidebarFile);
  $("#file-list").replaceChildren();
  $("#file-preview").textContent = "";
  $("#preview-filename").textContent =
    "파일을 선택하면 내용을 읽기 전용으로 표시합니다.";
  for (const entry of tree.files) {
    const button = document.createElement("button");
    button.className = `file-entry ${entry.type}`;
    button.textContent = `${entry.type === "directory" ? "▸ " : "  "}${entry.path}`;
    button.disabled = entry.type === "directory";
    const projectId = projectData.activeId;
    button.addEventListener("click", () =>
      busy(button, "읽는 중…", async () => {
        const text = await call(api.readFile(projectId, entry.path));
        if (projectId !== projectData.activeId) return;
        $("#preview-filename").textContent = entry.path;
        $("#file-preview").textContent = text;
      }),
    );
    $("#file-list").append(button);
  }
  if (!tree.files.length)
    $("#file-list").textContent =
      "빈 폴더입니다. 생성된 파일이 여기에 나타납니다.";
  if (tree.omitted) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "표시 한도를 넘는 파일이 있습니다.";
    $("#file-list").append(p);
  }
}
const RUN_LABELS = {
  testing: "테스트 코드 작성 중",
  planning: "명세 작성 중",
  building: "기능·UI 구현 중",
  validating: "검증 실행 중",
  reviewing: "컨트롤 타워 검토 중",
  repairing: "담당 AI 수정 중",
  final_review: "최종 교차 검토 중",
  completed: "전체 완료",
  awaiting_validation: "실행 검증 필요",
  needs_input: "사용자 답변 필요",
  awaiting_design: "UI 시안 승인 대기",
  needs_attention: "확인 필요",
  cancelled: "중지됨",
  interrupted: "이전 작업 중단됨",
};
let pendingDesignArtifact;
async function loadApprovedPreview(run) {
  if (run.design?.format === 'layout') return;
  if (pendingDesignArtifact === run.design.artifactId) return;
  pendingDesignArtifact = run.design.artifactId;
  try {
    const result = await call(api.latestImage(run.projectId));
    if (projectData?.activeId === run.projectId && currentRun?.design?.artifactId === result?.artifactId) {
      resultCache.set(run.projectId, result);
      resultImage = result;
      renderImage();
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    pendingDesignArtifact = null;
  }
}
function renderWorkflow(run) {
  currentRun = run;
  $('#review-chain-panel').hidden = !run?.reviewChain?.length;
  $('#review-chain-list').replaceChildren(...(run?.reviewChain??[]).map((step,index)=>{
    const item=document.createElement('li');item.dataset.reviewActor=step.actor;item.dataset.reviewStatus=step.status;
    const labels={pending:'대기',working:'검토 중',passed:'OK',changes:'수정 필요',blocked:'테스트 확인 필요'};
    item.textContent=`${index+1}. ${AI_NAMES[step.provider]}${step.actor==='gpt'?' · 컨트롤 타워 (마지막)':''} — ${labels[step.status]??step.status}${step.summary?' · '+step.summary:''}`;
    return item;
  }));
  clarificationUI.update(run);
  const failure = run?.testFailure;
  $("#test-recovery").hidden = !failure;
  $("#test-recovery-title").textContent = failure
    ? (failure.status === "intervention" ? "사용자 확인 필요" : "테스트 실패 · 자동 수정") +
      ` · 수정 ${run.round}/${run.options.maxRepairRounds}회`
    : "";
  $("#test-recovery-reason").textContent = failure
    ? [failure.reason, failure.owners?.length ? "담당 " + failure.owners.map((id) => {
      const panel = run.options.team?.find((row) => row.id === id);
      return panel ? AI_NAMES[panel.provider] + " " + panel.roles.map((role) => CAPABILITIES[role]).join("/") : id;
    }).join(", ") : ""].filter(Boolean).join(" · ")
    : "";
  $("#test-recovery-details").textContent = failure ? [...failure.names, ...failure.stack].join("\n") : "";
  const awaitingDesign = run?.status === "awaiting_design";
  $("#design-approval-banner").hidden = !awaitingDesign;
  $("#design-approval-status").textContent = ({
    ready: "UI 시안을 확인해 보세요. ‘이대로 적용’으로 승인하거나 ‘시안 수정: 바꿀 내용’을 보내세요.",
    error: "시안을 만들지 못했습니다. UI 시안에서 API 키를 연결하거나 다시 생성하세요.",
  })[run?.design?.status] ?? "UI 시안을 만드는 중입니다.";
  renderDesignDelivery();
  renderImage();
  if (awaitingDesign && run.design?.status === "ready" && resultImage?.artifactId !== run.design.artifactId)
    void loadApprovedPreview(run);
  $("#rollback-banner").hidden = !(run?.batchRollback && ["needs_attention", "awaiting_validation", "cancelled", "interrupted"].includes(run.status) &&
    run.tasks?.some((task) => task.report?.changed?.length || task.status === "reported"));
  $("#rollback-reason").textContent = run?.status === "awaiting_validation" ? (run.validation?.requiresConsent ? "검증 권한 필요" : "검증 실패") : RUN_LABELS[run?.status] ?? "작업 확인 필요";
  const usage = run?.usage;
  const cost = usage?.estimatedUsd === undefined ? "" : ` · 추정 $${usage.estimatedUsd.toFixed(4)}${usage.costUnknown ? " (일부)" : ""}`;
  $("#work-usage-summary").textContent = usage
    ? `이번 작업 · 호출 ${usage.calls}${run.options.maxAgentCalls ? "/" + run.options.maxAgentCalls : ""} · 수정 ${run.round}회${cost}`
    : "이번 작업 사용량 · 대기";
  $("#work-usage-panels").replaceChildren(...Object.entries(usage?.byPanel ?? {}).map(([id, row]) => {
    const item = document.createElement("li");
    const team = run.options.team?.find((agent) => agent.id === id);
    const source=row.lastProvider??run.options.runtimeRoutes?.[id]?.provider??team?.provider;
    const label = team ? `${AI_NAMES[source]} · ${team.roles.map((role) => CAPABILITIES[role]).join(" / ")}` : id;
    const tokens = row.measured ? `입력 ${row.input.toLocaleString()} · 출력 ${row.output.toLocaleString()} (${row.measured}/${row.calls}건 집계)` : "토큰 조회 미지원";
    const providers=Object.entries(row.providers??{}).map(([provider,calls])=>`${AI_NAMES[provider]} ${calls}회`).join(" → ");
    item.textContent = `${label} · ${row.calls}회 · ${tokens} · 누적 ${((row.elapsedMs ?? 0) / 1000).toFixed(1)}초` + (row.estimatedUsd === undefined ? "" : ` · 추정 $${row.estimatedUsd.toFixed(4)}`) + (providers?` · ${providers}`:"");
    return item;
  }));
  const mutation = $("#mutation-summary");
  $("#mutation-details").hidden = !run?.options?.mutation;
  mutation.textContent = "뮤테이션 테스트 · " + (run?.mutation?.summary ?? "기본 테스트 후 실행 대기");
  $("#mutation-command").textContent = [run?.mutation?.command, run?.mutation?.reportPath].filter(Boolean).join(" · ");
  $("#mutation-findings").replaceChildren(...(run?.mutation?.findings ?? []).map((finding) => {
    const item = document.createElement("li");
    item.textContent = `${finding.status} · ${finding.file}:${finding.line ?? "?"} · ${finding.replacement}`;
    return item;
  }));
  renderInspector(run);
  $("#project-state").textContent = run
    ? (RUN_LABELS[run.status] ?? run.status)
    : "작업 대기";
  $("#run-state-dot").classList.toggle("mint-dot", run?.status === "completed");
  $("#round-indicator").textContent = run
    ? `수정 ${run.round} / ${run.options.maxRepairRounds}회`
    : "수정 라운드 —";
  renderConversationPanels(run);
  renderAssignedRoles();
  if (run?.status === "needs_input")
    $("#run-readiness").textContent =
      "요구사항 답변을 기다립니다. ‘질문에 답변하기’에서 선택하거나 직접 입력하세요.";
  updateReadiness();
}
$("#choose-folder").addEventListener("click", () =>
  busy($("#choose-folder"), "폴더 선택 중…", async () => {
    const ticket = await call(api.chooseFolder(projectData.activeId));
    if (!ticket) return;
    folderTicket = ticket;
    $("#consent-path").textContent = ticket.root;
    $("#folder-consent-check").checked = false;
    $("#folder-consent").showModal();
  }),
);
$("#cancel-folder-consent").addEventListener("click", () => {
  folderTicket = null;
  $("#folder-consent").close();
});
$("#folder-consent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!folderTicket) return;
  await busy($("#confirm-folder"), "연결 중…", async () => {
    const data = await call(
      api.grantFolder(
        folderTicket.projectId,
        folderTicket.ticket,
        $("#folder-consent-check").checked,
      ),
    );
    resultCache.delete(folderTicket.projectId);
    folderTicket = null;
    $("#folder-consent").close();
    renderProjects(data);
    toast("선택한 폴더와 하위 폴더를 프로젝트에 연결했습니다.", "success");
  });
});
$("#revoke-folder").addEventListener("click", () =>
  busy($("#revoke-folder"), "접근 해제 중…", async () => {
    const id = projectData.activeId;
    const data = await call(api.revokeFolder(id));
    resultCache.delete(id);
    renderProjects(data);
    toast(
      "작업을 중지하고 폴더 접근 동의를 해제했습니다. 생성물은 폴더에 남아 있습니다.",
    );
  }),
);
$("#open-folder").addEventListener("click", () =>
  busy($("#open-folder"), "여는 중…", () =>
    call(api.openFolder(projectData.activeId)),
  ),
);
$("#show-files").addEventListener("click", () =>
  busy($("#show-files"), "읽는 중…", async () => {
    await refreshWorkspace();
    $("#files-dialog").showModal();
  }),
);
$("#close-files").addEventListener("click", () => $("#files-dialog").close());
function controllerIssues() {
  return requestIssues({ folder: linkedFolder, team: teamConfig, roleSaving, connection,
    gptModel: $('#gpt-model').value, question: $('#controller-mode').value === 'question', text: $('#planner-input').value });
}
const showRequestAlerts = createRequestAlerts(issue => {
  if (issue.action === 'roles') void openRoles(issue.agentId).then(() => document.querySelector(`#panel-model-${issue.agentId ?? 'gpt'}`)?.focus());
  else if (issue.action === 'connections') openConnections();
  else if (issue.action === 'folder') $('#choose-folder').click();
  else $('#planner-input').focus();
});
$("#start-workflow").addEventListener("click", () => {
  const issues = controllerIssues();
  return busy($("#start-workflow"), "전송 중…", async () => {
    const projectId = projectData.activeId;
    if (issues.length) {
      await call(api.checkWorkTools(projectId));
      showRequestAlerts(issues);return;
    }
    if (!currentConversation) await loadConversation();
    const conversationId = currentConversation.id;
    const message = $("#planner-input").value.trim();
    if (!message) return;
    const result = await call(
      api.sendMessage(
        projectId,
        conversationId,
        "gpt",
        message,
        $("#controller-mode").value,
        $("#mutation-option").checked,
        selectedImageProvider(),
        $('#fun-option').checked,
      ),
    );
    $("#planner-input").value = "";
    if (result.state) {
      activeRuns.set(projectId, result.state);
      if (
        projectData.activeId === projectId &&
        currentConversation?.id === conversationId
      ) {
        currentConversation.runId = result.state.id;
        renderWorkflow(result.state);
      }
    }
    await loadConversation(conversationId);
    if (currentRun?.status === "awaiting_design" && /마음에\s*안|다시\s*만들|시안\s*수정/.test(message)) openDesign();
  });
});
$('#fun-option').addEventListener('change', async () => {
  const control = $('#fun-option'), desired = control.checked;
  funSaving = true;
  control.disabled = true;
  try { preferences = await call(api.setFunDefault(desired)); control.checked = preferences.funByDefault; }
  catch (error) { control.checked = !desired; toast(error.message, 'error'); }
  finally { funSaving = false; updateReadiness(); }
});
$("#stop-workflow").addEventListener("click", () =>
  busy($("#stop-workflow"), "중지 중…", async () => {
    renderWorkflow(await call(api.stopWorkflow(projectData.activeId)));
    await refreshWorkspace();
  }),
);
function renderCliLogin(provider, status = {}) {
  const login = status.login ?? {};
  const connected = status.connected === true;
  $(`#${provider}-login`).disabled =
    !status.installed || (connected && provider !== "grok") || login.waiting;
  $(`#${provider}-login`).textContent = login.waiting
    ? "공식 로그인 대기 중…"
    : provider === "grok" && status.installed
      ? "Cursor 로그인 ↗"
      : connected
        ? "터미널 로그인 연결됨"
        : status.installed
          ? "연결하기 ↗"
          : "공식 CLI 설치 필요";
  $(`#${provider}-reauth`).hidden = !connected;
  $(`#${provider}-reauth`).disabled = Boolean(login.waiting);
  $(`#${provider}-login-flow`).hidden = !login.waiting;
  $(`#${provider}-login-browser`).hidden = !login.hasBrowserLink;
  $(`#${provider}-code-form`).hidden = !login.codeRequired;
  if (!login.waiting) $(`#${provider}-code`).value = "";
  if (provider === "grok") $("#grok-reauth").textContent = "기존 연결 확인";
}
async function connectCLI(provider, force = false) {
  const button = $(`#${provider}-${force ? "reauth" : "login"}`);
  await busy(button, "저장된 연결 확인 중…", async () => {
    const result = await call(
      provider === "claude" ? api.claudeLogin(force) : api.grokLogin(force),
    );
    message(
      `#${provider}-message`,
      result.reused
        ? result.message
        : "공식 브라우저에서 로그인과 승인을 완료하세요.",
      result.reused ? "success" : "",
    );
    await refreshStatus();
  });
  if (connection?.[provider]) renderCliLogin(provider, connection[provider]);
}
async function restoreSavedConnections(prepared) {
  if (restoring) return null;
  restoring = true;
  $("#session-status").dataset.restoring = "true";
  $("#session-status").textContent = "저장된 연결 확인 중…";
  try {
    const result = prepared??await call(api.restoreConnections());
    const count =
      Number(result.gpt.connected) +
      Number(result.claude.connected) +
      Number(result.grok.connected) +
      Number(result.gemini.connected);
    $("#session-status").textContent = count
      ? `${count}개 AI 연결 확인 · 저장된 로그인 사용`
      : "로그인 연결을 선택하세요.";
    $("#session-policy").textContent = result.session.recheckRequired
      ? "7일 미사용 후 재확인 중 일부 연결을 확인하지 못했습니다. 기존 로그인은 유지되며 다시 확인할 수 있습니다."
      : "한 번 연결하면 다음 실행에도 유지합니다. 7일 미사용 후에는 상태를 재확인하고 유효하면 로그인 없이 계속합니다.";
    $("#login-browser").value = result.browser.preferred;
    $("#login-browser option[value=chrome]").disabled =
      !result.browser.chromeAvailable;
    return result;
  } catch (error) {
    $("#session-status").textContent = "저장된 연결 확인이 필요합니다.";
    toast(error.message, "error");
    return null;
  } finally {
    restoring = false;
    $("#session-status").dataset.restoring = "false";
  }
}
for (const provider of ["claude", "grok"]) {
  $(`#${provider}-reauth`).addEventListener("click", () =>
    connectCLI(provider, provider !== "grok"),
  );
  $(`#${provider}-login-browser`).addEventListener("click", () =>
    busy($(`#${provider}-login-browser`), "브라우저 여는 중…", () =>
      call(api.loginBrowser(provider)),
    ),
  );
  $(`#${provider}-cancel-login`).addEventListener("click", () =>
    busy($(`#${provider}-cancel-login`), "취소 중…", async () => {
      await call(api.cancelCliLogin(provider));
      await refreshStatus();
    }),
  );
  $(`#${provider}-code-form`).addEventListener("submit", (event) => {
    event.preventDefault();
    const value = $(`#${provider}-code`).value;
    $(`#${provider}-code`).value = "";
    void busy($(`#${provider}-code-form button`), "확인 중…", async () => {
      await call(api.loginCode(provider, value));
      toast("승인 코드를 공식 CLI에 전달했습니다.");
      await refreshStatus();
    });
  });
}
$("#restore-connections").addEventListener("click", () =>
  busy($("#restore-connections"), "확인 중…", async () => {
    await restoreSavedConnections();
    await refreshStatus();
  }),
);
$("#login-browser").addEventListener("change", async (event) => {
  try {
    await call(api.setBrowser(event.target.value));
    toast("로그인 브라우저 설정을 저장했습니다.");
  } catch (error) {
    toast(error.message, "error");
    $("#login-browser").value = (await call(api.browserSettings())).preferred;
  }
});
$("#grok-model").addEventListener("change", async (event) => {
  if (!event.target.value) return;
  try {
    await call(api.selectGrokModel(event.target.value));
    await refreshStatus();
    toast(
      "Cursor의 Grok 모델을 저장했습니다. 실행 중인 작업은 시작할 때 선택한 모델을 유지합니다.",
    );
  } catch (error) {
    toast(error.message, "error");
    await refreshStatus();
  }
});
const usageNames = {
  gpt: "GPT · 이 앱의 직접 로그인",
  claude: "Claude · 공식 /usage",
  grok: "Grok · Cursor 계정 사용 한도",
  codex: "Codex CLI · 별도 계정 참고 한도",
  gemini: "Gemini · 공식 한도 확인",
};
const usageLinks = {
  gpt: "gptUsage",
  claude: "claudeUsage",
  grok: "cursorUsage",
  codex: "codexUsage",
  gemini: "gemini",
};
function displayedUsage(provider) {
  if (provider === "gpt" && connection?.gpt.source === "codex") {
    const data = usageData.providers.codex;
    return {
      ...data,
      message:
        "현재 GPT 실행에 사용하는 Codex ChatGPT 계정의 공식 사용 한도입니다. " +
        data.message.replace(
          "이 앱의 GPT 직접 로그인 계정과 같다고 가정하지 않습니다.",
          "",
        ),
    };
  }
  return (
    usageData.providers[provider] ?? {
      state: "unsupported",
      meters: [],
      remainingPercent: null,
      message:
        "이 경로에서 확인된 5시간·주간 잔여 비율이 없습니다. 공식 안내에서 계정 한도를 확인하세요.",
    }
  );
}
function renderUsage(value) {
  usageData = value;
  const nativeGpt = connection?.gpt.source === "codex";
  usageNames.gpt = nativeGpt
    ? "GPT · Codex ChatGPT 실행 계정"
    : "GPT · 이 앱의 직접 로그인";
  $("[data-usage=gpt] small").textContent = nativeGpt
    ? "Codex 실행 계정"
    : "직접 로그인";
  $("[data-usage=codex] small").textContent = nativeGpt
    ? "GPT와 동일 출처"
    : "별도 계정 · 참고";
  for (const provider of ["gpt", "claude", "grok", "gemini", "codex"]) {
    const data = displayedUsage(provider);
    const numeric =
      typeof data.remainingPercent === "number" &&
      Number.isFinite(data.remainingPercent) &&
      data.remainingPercent >= 0 &&
      data.remainingPercent <= 100;
    const windows = quotaWindows(data);
    $("#quota-" + provider).textContent = windows.available
      ? windows.text
      : data.state === "unsupported"
        ? "조회 미지원"
        : "—/—";
    const button = $(`[data-usage=${provider}]`);
    button.hidden =
      provider === "codex"
        ? nativeGpt
        : teamConfig
          ? ![...teamConfig, ...currentDisplayTeam()].some((agent) => agent.provider === provider)
          : false;
    button.classList.toggle("has-quota", numeric);
    button.title = `5시간 / 주간 · ${data.message}${data.checkedAt ? " · " + new Date(data.checkedAt).toLocaleTimeString("ko-KR") : ""}`;
    button.setAttribute(
      "aria-label",
      `${usageNames[provider]} ${$(`#quota-${provider}`).textContent}`,
    );
  }
  $("#usage-refresh-state").textContent = value.checkedAt
    ? `10초 갱신 · ${new Date(value.checkedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })} 확인`
    : "확인된 값만 표시";
  if ($("#usage-dialog").open) renderUsageDetail();
}
async function refreshUsage(manual) {
  try {
    const value = await call(manual ? api.refreshUsage() : api.pollUsage());
    renderUsage(value);
  } catch {
    if (manual)
      toast("사용량 조회에 실패했습니다. 공급자 연결을 확인하세요.", "error");
  }
}
function renderUsageDetail() {
  if (!usageData) return;
  const data = displayedUsage(usageProvider);
  if (!data) return;
  $("#usage-title").textContent = usageNames[usageProvider];
  $("#usage-description").textContent =
    `${data.message}${data.accountLabel ? " · 계정: " + data.accountLabel : ""}`;
  $("#usage-checked-at").textContent = data.checkedAt
    ? `최근 확인: ${new Date(data.checkedAt).toLocaleString("ko-KR")}`
    : "아직 조회하지 않았습니다.";
  $("#usage-meters").replaceChildren();
  for (const meter of data.meters ?? []) {
    const row = document.createElement("div");
    row.className = "usage-meter-row";
    const text = document.createElement("p");
    text.textContent = `${meter.label}${meter.model ? " · " + meter.model : ""}${meter.surface ? " · " + meter.surface : ""}${meter.windowMinutes ? " · " + meter.windowMinutes + "분 창" : ""}${meter.active === false ? " · 현재 미적용" : ""}`;
    const number = document.createElement("strong");
    number.textContent = `${meter.remainingPercent}% 잔여`;
    const bar = document.createElement("meter");
    bar.min = 0;
    bar.max = 100;
    bar.value = meter.remainingPercent;
    bar.setAttribute("aria-label", `${text.textContent} 잔여 비율`);
    const reset = document.createElement("p");
    reset.className = "hint";
    reset.textContent = meter.resetsAt
      ? `초기화: ${new Date(meter.resetsAt).toLocaleString("ko-KR")}`
      : "초기화 시각 미제공";
    row.append(text, number, bar, reset);
    $("#usage-meters").append(row);
  }
}
document.querySelectorAll("[data-usage]").forEach((button) =>
  button.addEventListener("click", () => {
    usageProvider = button.dataset.usage;
    renderUsageDetail();
    $("#usage-dialog").showModal();
  }),
);
$("#close-usage").addEventListener("click", () => $("#usage-dialog").close());
$("#official-usage-page").addEventListener("click", () =>
  busy($("#official-usage-page"), "여는 중…", () =>
    call(
      api.openLink(
        usageProvider === "gpt" && connection?.gpt.source === "codex"
          ? "codexUsage"
          : usageLinks[usageProvider],
      ),
    ),
  ),
);
$("#refresh-usage").addEventListener("click", () =>
  busy($("#refresh-usage"), "조회 중…", () => refreshUsage(true)),
);
async function noteActivity() {
  if (!api || Date.now() - lastActivity < 30000) return;
  lastActivity = Date.now();
  try {
    const session = await call(api.activity());
    if (session.recheckRequired && !restoring) {
      await restoreSavedConnections();
      await refreshStatus();
    }
  } catch {}
}
document.addEventListener(
  "pointerdown",
  () => {
    void noteActivity();
  },
  { passive: true },
);
document.addEventListener("keydown", () => {
  void noteActivity();
});
window.addEventListener("focus", () => {
  void noteActivity();
  void refreshUsage(false);
  void prerequisiteWatcher.check();
});
setInterval(() => {
  if (document.visibilityState === "visible") void refreshUsage(false);
}, 10000);
function renderAssignedRoles() {
  if (usageData) renderUsage(usageData);
  const selected = currentDisplayTeam();
  if (!selected) return;
  renderPanelTeam(selected);
  const controller=selected[0];
  if (controller) {
    $("#gpt-model").hidden=controller.provider!=="gpt"||!!controller.modelId;
    $("#model-button").textContent=controller.modelId|| (controller.provider!=="gpt"?AI_NAMES[controller.provider]+" 모델 선택":"모델 선택 ▾");
  }
  $("#role-summary").textContent = (teamConfig ?? selected)
    .map(
      (agent, index) =>
        String(index + 1).padStart(2, "0") +
        " " +
        AI_NAMES[agent.provider] +
        " · " +
        agent.roles.map((role) => CAPABILITIES[role]).join("/"),
    )
    .join("  |  ");
  for (const agent of selected) {
    const ready =
      agent.provider === "gpt"
        ? connection?.gpt?.connected
        : connection?.[agent.provider]?.connected;
    if (!ACTIVE_RUN.has(currentRun?.status))
      pill("#" + agent.id + "-status", ready ? "연결됨" : "연결 필요", ready);
    else if (agent.id === "gpt")
      pill("#gpt-status", RUN_LABELS[currentRun.status] ?? "작업 중", true);
    if (pendingChats.get(agent.id) === currentConversation?.id)
      pill("#" + agent.id + "-status", "응답 중", false);
    if (agent.id !== "gpt") {
      const panel = document.querySelector(
        '[data-agent-panel="' + agent.id + '"]',
      );
      panel.querySelector(".agent-name p").textContent =
        AI_NAMES[agent.provider] + " · 독립 실행 세션";
      const label = panel.querySelector(".worker-footer>span");
      if (label) label.textContent = agent.modelId || "현재 AI 계정의 자동 선택 모델";
    }
  }
  const feature = selected.find((agent) => agent.id === "grok");
  if (feature) {
    const provider = feature.provider;
    const model =
      feature.modelId ||
      (provider === "grok"
        ? connection?.grok.modelId
        : provider === "gemini"
          ? connection?.gemini.modelId
          : provider === "gpt"
            ? $("#gpt-model").value
            : "Claude CLI 기본 모델");
    $("#grok-model-label").textContent =
      model ||
      (provider === "gpt" && connection?.gpt.source === "codex"
        ? "Codex CLI 기본 모델"
        : AI_NAMES[provider] + " 모델 선택 필요");
  }
  refreshMission();
}
function refreshMission() {
  const team = currentDisplayTeam();
  mission.update({
    run: currentRun, team,
    projectId: projectData?.activeId,
    conversationId: currentConversation?.id,
    linked: Boolean(linkedFolder),
    connected: team.length > 0 && team.every((row) => row.provider === "gpt" ? connection?.gpt?.connected : connection?.[row.provider]?.connected),
    delivery: missionDelivery?.runId === currentRun?.id ? missionDelivery : null,
  });
  desk.update({run:currentRun,team,configuredTeam:teamConfig,connections:connection??{},projectId:projectData?.activeId,conversationId:currentConversation?.id});
  mascot.update(currentRun,team);
  if (usageData) renderUsage(usageData);
}
function missionAction(target) {
  if (target === "workflow") return desk.openWorkflow();
  if (target === "design") return openDesign();
  if (target === "project") return $("#new-project").click();
  if (target === "connections") return $("#open-connections").click();
  if (target === "roles") return $("#open-roles").click();
  if (target === "settings") return $("#open-settings").click();
  if (target === "checkpoints") return $("#open-checkpoints").click();
  if (target === "delivery") {
    if (missionDelivery?.pending) return showReleaseApproval(missionDelivery.pending);
    return $("#open-services").click();
  }
  if (target === "testing") {
    if (currentRun?.mutation && !currentRun.mutation.passed && !$("#mutation-details").hidden) {
      desk.openWorkflow();
      $("#mutation-details").open = true;
      $("#mutation-details").scrollIntoView({ block: "center" });
      return;
    }
    if (!$("#show-test-report").hidden) return $("#show-test-report").click();
    if (currentRun?.validation) {
      const result = currentRun.validation;
      $("#test-report-content").textContent = [
        result.stale ? "이전 검증 결과 · 현재 파일에서 다시 실행해야 합니다." : result.summary,
        "실행 명령 · " + (result.command ?? "실행되지 않음"),
        "종료 코드 · " + (result.exitCode ?? "없음"),
        result.output ?? "저장된 실행 출력이 없습니다.",
      ].join("\n\n");
      $("#test-report-dialog").showModal();
      return;
    }
    desk.openWorkflow();
    $(".testing-inspector").scrollIntoView({ block: "center" });
    return;
  }
  view(false);
  if (target === "controller") { $("#planner-input").focus(); return; }
  const failed = target === "failed-output"
    ? currentRun?.tasks.find((task) => task.status === "failed") ?? currentRun?.tasks.find((task) => task.status === "blocked")
    : null;
  const actor = failed?.owner ?? (target === "output"
    ? currentRun?.tasks.find((task) => task.status === "working")?.owner ?? "gpt"
    : "gpt");
  mission.select(actor, failed?.id);
  if (target === "controller") $("#planner-input").focus();
}
let openingRoles=false;
async function openRoles(role = "gpt") {
  if (!projectData||openingRoles) return;
  openingRoles=true;
  const trigger=$("#open-roles"),label=trigger.textContent;trigger.disabled=true;trigger.textContent="설정 여는 중…";
  const id = projectData.activeId;
  try {
    const selected = await call(api.team(id));
    if (projectData.activeId !== id) return;
    rolesDialogProjectId = id;
    await renderTeamEditor(selected, panelModelCatalog);
    if (projectData.activeId !== id) return;
    $("#roles-dialog").showModal();
    document.querySelector("#role-" + role)?.focus();
  } catch (error) {
    toast(error.message, "error");
  } finally {openingRoles=false;trigger.disabled=false;trigger.textContent=label;}
}
function panelModelCatalog(provider) { const rows=preparedCatalog[provider]?.rows??[];return Promise.resolve(rows.map(row=>({...row,current:row.id===connection?.[provider]?.modelId}))); }
$("#open-roles").addEventListener("click", () => openRoles());
document
  .querySelectorAll(".change-role")
  .forEach((button) =>
    button.addEventListener("click", () => openRoles(button.dataset.role)),
  );
for (const id of ["#close-roles", "#close-roles-outside"])
  $(id).addEventListener("click", () => $("#roles-dialog").close());
$("#roles-connections").addEventListener("click", () => {
  $("#roles-dialog").close();
  openConnections();
});
$("#agent-count").addEventListener("change", async (event) => {
  const control=event.target,button=$('#save-roles');
  control.disabled=true;button.disabled=true;
  try {
    await resizeEditor(Number(event.target.value), panelModelCatalog);
  } catch (error) {
    toast(error.message, "error");
  } finally {control.disabled=false;button.disabled=false;}
});
$("#roles-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = rolesDialogProjectId;
  let selection;
  try {
    selection = readTeamEditor();
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  roleSaving = true;
  void busy($("#save-roles"), "저장 중…", async () => {
    const saved = await call(api.setTeam(id, selection));
    if (projectData.activeId === id) {
      teamConfig = saved;
      roleAssignments = Object.fromEntries(
        saved.map((agent) => [agent.id, agent.provider]),
      );
      rolesProjectId = id;
      renderAssignedRoles();
    }
    $("#roles-dialog").close();
    toast("팀 구성을 저장했습니다. 현재 실행은 시작 당시 배치를 유지합니다.");
  }).finally(() => {
    roleSaving = false;
    updateReadiness();
  });
});
function renderGeminiConnection(status = {}) {
  const login = status.login ?? {};
  pill(
    "#gemini-auth-status",
    status.connected
      ? "Google 연결됨"
      : login.waiting
        ? "승인 대기"
        : status.installed
          ? "연결 필요"
          : "설치 필요",
    status.connected,
  );
  $("#gemini-login").disabled = !status.installed || !!login.waiting;
  $("#gemini-login").textContent = login.waiting
    ? "Google 승인 대기 중…"
    : status.connected
      ? "기존 Google 연결 확인"
      : "Google 로그인 ↗";
  $("#gemini-install").hidden = !!status.installed;
  $("#gemini-login-flow").hidden = !login.waiting;
  $("#gemini-login-browser").hidden = !login.hasBrowserLink;
  if (
    status.modelId &&
    !Array.from($("#gemini-model").options).some(
      (option) => option.value === status.modelId,
    )
  )
    $("#gemini-model").append(new Option(status.modelId, status.modelId));
  $("#gemini-model").value = status.modelId ?? "";
  if (status.connected)
    message(
      "#gemini-message",
      "Gemini CLI의 Google 인증을 사용합니다. 실행할 모델을 선택하세요.",
      "success",
    );
  else if (!status.installed)
    message(
      "#gemini-message",
      "이 앱에서는 Node.js 24 이상과 공식 Gemini CLI를 사용합니다. 설정의 설치 도구 확인에서 공식 안내를 열 수 있습니다.",
    );
}
$("#gemini-login").addEventListener("click", async () => {
  await busy($("#gemini-login"), "Google 연결 준비 중…", async () => {
    const result = await call(api.geminiLogin());
    if (result.reused) message("#gemini-message", result.message, "success");
    await refreshStatus();
  });
  if (connection?.gemini) renderGeminiConnection(connection.gemini);
});
$("#gemini-install").addEventListener("click", () =>
  busy($("#gemini-install"), "Gemini CLI 설치 중…", async () => {
    await call(api.installGemini());
    await refreshStatus();
    toast("공식 Gemini CLI를 설치했습니다. Google 로그인을 누르세요.");
  }),
);
$("#gemini-login-browser").addEventListener("click", () =>
  busy($("#gemini-login-browser"), "여는 중…", () =>
    call(api.loginBrowser("gemini")),
  ),
);
$("#gemini-cancel-login").addEventListener("click", () =>
  busy($("#gemini-cancel-login"), "취소 중…", async () => {
    await call(api.cancelCliLogin("gemini"));
    await refreshStatus();
  }),
);
$("#gemini-model").addEventListener("change", async (event) => {
  if (!event.target.value) return;
  try {
    await call(api.selectGeminiModel(event.target.value));
    await refreshStatus();
    toast("Gemini 모델을 저장했습니다.");
  } catch (error) {
    toast(error.message, "error");
    await refreshStatus();
  }
});
$("#gpt-model").addEventListener("change", () => {
  renderAssignedRoles();
  updateReadiness();
});
function viewSidebarFile(path) {
  void busy($("#show-files"), "읽는 중…", async () => {
    $("#files-dialog").showModal();
    $("#preview-filename").textContent = path;
    $("#file-preview").textContent = await call(
      api.readFile(projectData.activeId, path),
    );
  });
}
$("#sidebar-file-search").addEventListener("input", () =>
  renderConversationTree(),
);
function toggleSidebar() {
  const visible =
    getComputedStyle(document.querySelector(".project-sidebar")).display !==
    "none";
  document.body.dataset.sidebar = visible ? "off" : "on";
  $("#toggle-sidebar").setAttribute("aria-expanded", String(!visible));
}
$("#toggle-sidebar").addEventListener("click", toggleSidebar);
$("#planner-input").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    event.currentTarget.value.trim().toLowerCase() === "/model"
  ) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.value = "";
    $("#model-button").click();
  }
});
$("#planner-input").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    !event.defaultPrevented
  ) {
    event.preventDefault();
    if (!$("#start-workflow").disabled) $("#start-workflow").click();
  }
});
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === "Enter" && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    if (!$("#start-workflow").disabled) $("#start-workflow").click();
  }
  if (event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
  }
});

let historyProject;
function renderHistory(preferred) {
  const select = $("#history-select");
  select.replaceChildren(new Option("대화를 선택하세요", ""));
  for (const row of (conversationIndex?.items ?? []).filter((row) => row.projectId === historyProject))
    select.add(new Option(row.title + (row.archived ? " · 보관됨" : ""), row.id));
  select.value = preferred ?? "";
  updateHistoryActions();
}
function updateHistoryActions() {
  const id = $("#history-select").value;
  const row = conversationIndex?.items.find((item) => item.id === id);
  $("#history-confirm-text").hidden = true;
  $("#history-delete").textContent = "삭제…";
  $("#history-archive").textContent = row?.archived ? "다시 열기" : "보관";
  for (const selector of ["#history-delete", "#history-export", "#history-archive"])
    $(selector).disabled = !row;
}
$("#open-history").addEventListener("click", () => busy($("#open-history"), "불러오는 중…", async () => {
  historyProject = projectData.activeId;
  await refreshConversationIndex();
  renderHistory(currentConversation?.id);
  $("#history-dialog").showModal();
}));
$("#close-history").addEventListener("click", () => $("#history-dialog").close());
$("#history-select").addEventListener("change", updateHistoryActions);
async function changeHistory(action) {
  const id = $("#history-select").value;
  const project = historyProject;
  conversationIndex = await call(api.conversationHistory(project, id, action));
  renderConversationTree();
  if (projectData.activeId === project && id === currentConversation?.id && action !== "restore")
    await loadConversation();
  renderHistory(action === "restore" ? id : "");
}
$("#history-archive").addEventListener("click", () => busy($("#history-archive"), "저장 중…", () => {
  const row = conversationIndex.items.find((item) => item.id === $("#history-select").value);
  return changeHistory(row?.archived ? "restore" : "archive");
}).finally(updateHistoryActions));
$("#history-delete").addEventListener("click", () => {
  if ($("#history-confirm-text").hidden) {
    $("#history-confirm-text").hidden = false;
    $("#history-delete").textContent = "영구 삭제";
    return;
  }
  void busy($("#history-delete"), "삭제 중…", () => changeHistory("delete")).finally(updateHistoryActions);
});
$("#history-export").addEventListener("click", () => busy($("#history-export"), "내보내는 중…", async () => {
  if (await call(api.exportConversation(historyProject, $("#history-select").value))) toast("Markdown 기록을 저장했습니다.");
}));
function renderConversationTree() {
  if (!projectData) return;
  conversationTree(projectData, conversationIndex, currentConversation?.id, {
    project: async (id) => {
      try {
        renderProjects(await call(api.selectProject(id)));
      } catch (error) {
        toast(error.message, "error");
      }
    },
    conversation: async (id, conversationId) => {
      try {
        if (projectData.activeId !== id)
          renderProjects(await call(api.selectProject(id)));
        await loadConversation(conversationId);
      } catch (error) {
        toast(error.message, "error");
      }
    },
    create: createConversation,
  });
}
async function refreshConversationIndex() {
  try {
    conversationIndex = await call(api.conversationIndex());
    renderConversationTree();
  } catch (error) {
    toast(error.message, "error");
  }
}
async function loadConversation(id) {
  if (!projectData) return;
  const projectId = projectData.activeId;
  const serial = ++conversationSerial;
  try {
    const data = await call(api.conversation(projectId, id));
    if (projectData.activeId !== projectId || serial !== conversationSerial)
      return;
    currentConversation = data.conversation;
    $("#conversation-title").textContent = currentConversation.title;
    renderWorkflow(data.run);
    await refreshConversationIndex();
  } catch (error) {
    if (serial === conversationSerial) toast(error.message, "error");
  }
}
async function createConversation(projectId = projectData.activeId) {
  try {
    if (projectData.activeId !== projectId)
      renderProjects(await call(api.selectProject(projectId)));
    const data = await call(api.createConversation(projectId));
    await loadConversation(data.id);
    $("#planner-input").focus();
  } catch (error) {
    toast(error.message, "error");
  }
}
function renderConversationPanels(run) {
  for (const actor of SLOT_IDS) {
    const provider =
      AI_NAMES[
        currentDisplayTeam().find((agent) => agent.id === actor)
          ?.provider
      ] ?? "AI";
    const events =
      run?.events?.filter(
        (event) =>
          event.actor === actor ||
          (actor === "gpt" && event.actor === "system"),
      ) ?? [];
    const messages =
      currentConversation?.messages.filter(
        (message) => message.agentId === actor,
      ) ?? [];
    const count = terminalFeed(
      $(actor === "gpt" ? "#planner-events" : "#" + actor + "-events"),
      events,
      messages,
      provider,
    );
    $("#" + (actor === "gpt" ? "planner" : actor) + "-empty").hidden =
      count > 0;
    const pending = pendingChats.get(actor) === currentConversation?.id;
    if (actor !== "gpt") {
      const button = document.querySelector(
        '.send-agent-chat[data-agent="' + actor + '"]',
      );
      button.disabled = pending || !linkedFolder;
      document.querySelector(
        '.stop-agent-chat[data-agent="' + actor + '"]',
      ).hidden = !pending;
    }
    const progress = $("#" + actor + "-progress");
    const buffer = liveBuffers.get(currentConversation?.id + ":" + actor);
    progress.hidden = !buffer;
    if (buffer) progress.textContent = buffer.slice(-20000);
    if (actor !== "gpt" && run) {
      const tasks = run.tasks.filter((task) => task.owner === actor);
      pill(
        "#" + actor + "-status",
        pending
          ? "응답 중"
          : tasks.some((task) => task.status === "working")
            ? "작업 중"
            : tasks.filter((task) => task.status === "reported").length +
              "/" +
              tasks.length +
              " 보고",
        false,
      );
    }
  }
  testingInspector(run);
  visualView.render(run);
}
$("#new-conversation").addEventListener("click", () => createConversation());
for (const form of document.querySelectorAll(".agent-chat-form")) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const actor = form.dataset.agent;
    void busy(form.querySelector(".send-agent-chat"), "전송 중…", async () => {
      if (!currentConversation) await loadConversation();
      const input = $("#" + actor + "-input");
      const message = input.value.trim();
      if (!message) return;
      await call(
        api.sendMessage(
          projectData.activeId,
          currentConversation.id,
          actor,
          message,
          "question",
        ),
      );
      input.value = "";
      await loadConversation(currentConversation.id);
    });
  });
  form.querySelector("textarea").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}
document
  .querySelectorAll(".stop-agent-chat")
  .forEach((button) =>
    button.addEventListener("click", () =>
      call(api.stopMessage(projectData.activeId, button.dataset.agent)),
    ),
  );
$("#planner-input").addEventListener("input", updateReadiness);
$("#controller-mode").addEventListener("change", () => {
  autoQuestion = false;
  updateReadiness();
});
let executionApproved = false;
async function refreshProjectExecution() {
  const project = projectData?.activeId;
  const linked = Boolean(projectData && activeProject()?.workspace);
  const button = $("#project-execution");
  const approved = linked ? await call(api.projectExecution(project)).catch(() => false) : false;
  if (projectData?.activeId !== project) return;
  executionApproved = approved;
  button.disabled = !linked;
  button.textContent = approved ? "현재 폴더 실행 승인 철회" : "현재 폴더 코드 실행 승인";
  $("#project-execution-status").textContent = !linked ? "작업 폴더를 먼저 연결하세요." : approved ? "현재 폴더 승인됨" : "현재 폴더 미승인";
}
$("#project-execution").addEventListener("click", () => {
  const project = projectData?.activeId;
  void busy($("#project-execution"), "승인 확인 중…", () => call(api.projectExecution(project, !executionApproved)))
    .finally(refreshProjectExecution);
});
$("#settings-dialog").addEventListener("toggle", (event) => {
  if (event.newState === "open") void refreshProjectExecution();
});
$("#open-settings").addEventListener("click", async () => {
  preferences = await call(api.preferences());
  fillPreferences(preferences);
  $("#settings-dialog").showModal();
  const quota = await call(api.callQuota());
  $('#call-quota-status').textContent = `오늘 (UTC ${quota.day}) · 전체 ${quota.calls}회 / 이미지 ${quota.images}회 · 텍스트 API 예약·사용 $${quota.reservedOrSpentUsd.toFixed(4)}`;
});
let checkpointProject;
let checkpointToken;
async function previewCheckpoint() {
  const id = $("#checkpoint-select").value;
  checkpointToken = null;
  $("#confirm-checkpoint").disabled = true;
  $("#checkpoint-preview").textContent = "";
  if (!id) return;
  const project = checkpointProject;
  const result = await call(api.restoreCheckpoint(project, id, null));
  if (project !== checkpointProject || id !== $("#checkpoint-select").value) return;
  const labels = { restore: "복원", delete: "생성 파일 삭제", conflict: "사용자 변경과 충돌", unchanged: "변경 없음" };
  $("#checkpoint-preview").textContent = result.preview.map((row) => `${labels[row.action]} · ${row.path}`).join("\n") || "되돌릴 변경이 없습니다.";
  checkpointToken = result.canRestore ? result.token : null;
  $("#confirm-checkpoint").disabled = !checkpointToken;
}
async function refreshVerifiedCheckpoint(id) {
  const marker = await call(api.verifiedCheckpoint(id)).catch(() => null);
  if (projectData?.activeId !== id) return;
  $("#verified-checkpoint-label").textContent = marker
    ? "마지막 검증 통과 · " + new Date(marker.at).toLocaleString()
    : "검증 통과 기록 없음";
  $("#restore-verified").hidden = !marker;
}
async function openCheckpoint(selection = "") {
  checkpointProject = projectData.activeId;
  const rows = await call(api.checkpoints(checkpointProject));
  const select = $("#checkpoint-select");
  select.replaceChildren(new Option("변경 묶음을 선택하세요", ""));
  for (const row of rows.filter((entry) => entry.status !== "reverted"))
    select.add(new Option(`${row.label} · ${new Date(row.at).toLocaleString()}${row.status === "committed" ? "" : " · 복구 확인"}`, row.id));
  if (selection) {
    select.add(new Option(selection === "verified" ? "마지막 검증 통과 상태" : "이 작업의 변경 전 상태", selection));
    select.value = selection;
  }
  await previewCheckpoint();
  if (!selection && !rows.length) $("#checkpoint-preview").textContent = "저장된 변경 묶음이 없습니다.";
  $("#checkpoints-dialog").showModal();
}
for (const [selector, scope] of [
  ["#open-checkpoints", () => ""],
  ["#restore-verified", () => "verified"],
  ["#rollback-run", () => "run:" + currentRun.id],
]) {
  $(selector).addEventListener("click", () => busy($(selector), "불러오는 중…", () => openCheckpoint(scope())));
}
$("#checkpoint-select").addEventListener("change", () => {
  previewCheckpoint().catch((error) => toast(error.message, "error"));
});
$("#close-checkpoints").addEventListener("click", () => $("#checkpoints-dialog").close());
$("#confirm-checkpoint").addEventListener("click", () => busy($("#confirm-checkpoint"), "복원 중…", async () => {
  const result = await call(api.restoreCheckpoint(checkpointProject, $("#checkpoint-select").value, checkpointToken));
  if (!result.id) {
    await previewCheckpoint();
    throw new Error("파일 상태가 바뀌어 복원하지 않았습니다.");
  }
  $("#checkpoints-dialog").close();
  await refreshWorkspace();
  toast("선택한 변경을 복원했습니다. 새 작업에서 다시 검증하세요.");
}));
$("#close-settings").addEventListener("click", () =>
  $("#settings-dialog").close(),
);
$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy($("#save-settings"), "저장 중…", async () => {
    preferences = await call(api.savePreferences(readPreferences()));
    fillPreferences(preferences);
    $("#settings-dialog").close();
    toast("작업 환경 설정을 저장했습니다.");
    updateReadiness();
  });
});
$("#show-test-report").addEventListener("click", () =>
  busy($("#show-test-report"), "불러오는 중…", async () => {
    $("#test-report-content").textContent =
      (currentRun?.testing?.stale
        ? "이전 실행 결과입니다. 소스 변경 후 재검증 전까지 현재 코드의 통과로 인정하지 않습니다.\n\n"
        : "") +
      (await call(api.testReport(projectData.activeId, currentRun.id)));
    $("#test-report-dialog").showModal();
  }),
);
$("#stop-controller-chat").addEventListener("click", () =>
  call(api.stopMessage(projectData.activeId, "gpt")),
);
$("#close-test-report").addEventListener("click", () =>
  $("#test-report-dialog").close(),
);
$("#test-permissions").addEventListener("click", () =>
  $("#open-settings").click(),
);
$("#rerun-tests").addEventListener("click", () =>
  busy($("#rerun-tests"), "실행 중…", async () => {
    renderWorkflow(
      await call(api.rerunTests(projectData.activeId, currentRun.id)),
    );
  }),
);
let renderedGptSource = null;
function renderCodexConnection(status) {
  const cli = status.codex;
  $("#gpt-source").value = status.gpt.source;
  pill(
    "#codex-auth-status",
    cli.connected
      ? "현재 PC 로그인됨"
      : cli.installed
        ? "로그인 필요"
        : "설치 필요",
    cli.connected,
  );
  $("#codex-login").disabled = !cli.installed || cli.login?.waiting;
  $("#codex-reauth").disabled = !cli.installed || cli.login?.waiting;
  $("#codex-login-flow").hidden = !cli.login?.waiting;
  $("#codex-login-browser").hidden = !cli.login?.hasBrowserLink;
  $("#security-notice").textContent = status.securityNotice ?? "";
  if (cli.connected)
    message(
      "#codex-message",
      "현재 OS 사용자의 ChatGPT 구독을 사용합니다. 같은 GPT로 여러 패널을 배정해도 로그인은 한 번이면 됩니다.",
      "success",
    );
  if (renderedGptSource && renderedGptSource !== status.gpt.source)
    $("#gpt-model").replaceChildren(new Option("GPT 모델 선택", ""));
  renderedGptSource = status.gpt.source;
  if (
    status.gpt.modelId &&
    !Array.from($("#gpt-model").options).some(
      (option) => option.value === status.gpt.modelId,
    )
  )
    $("#gpt-model").append(new Option(status.gpt.modelId, status.gpt.modelId));
  if (status.gpt.modelId && !$("#gpt-model").value)
    $("#gpt-model").value = status.gpt.modelId;
}
async function connectCodex(force = false) {
  await busy(
    $(force ? "#codex-reauth" : "#codex-login"),
    "연결 확인 중…",
    async () => {
      const result = await call(api.codexLogin(force));
      message(
        "#codex-message",
        result.reused
          ? result.message
          : "공식 ChatGPT 브라우저에서 승인을 완료하세요.",
      );
      await refreshStatus();
    },
  );
  if (connection) renderCodexConnection(connection);
}
$("#codex-login").addEventListener("click", () => connectCodex());
$("#codex-reauth").addEventListener("click", () => connectCodex(true));
$("#codex-login-browser").addEventListener("click", () =>
  busy($("#codex-login-browser"), "여는 중…", () =>
    call(api.loginBrowser("codex")),
  ),
);
$("#codex-cancel-login").addEventListener("click", () =>
  busy($("#codex-cancel-login"), "취소 중…", async () => {
    await call(api.cancelCliLogin("codex"));
    await refreshStatus();
  }),
);
$("#gpt-source").addEventListener("change", (event) => {
  const source = event.target.value;
  void busy($("#codex-login"), "경로 저장 중…", async () => {
    await call(api.setGptSource(source));
    await refreshStatus();
  });
});
$("#gpt-model").addEventListener("change", () => {
  void call(api.saveGptModel($("#gpt-model").value)).catch((error) =>
    toast(error.message, "error"),
  );
});
const tourSteps = [
  ["새 프로젝트", "상단 또는 왼쪽의 새 프로젝트에서 작업 폴더를 선택하세요. 왼쪽에서 프로젝트별 대화를 다시 열 수 있습니다."],
  ["계정 연결과 AI 역할 변경", "계정 연결에서 기존 CLI 연결을 확인하세요. AI 역할 변경에서 컨트롤 타워와 기능 구현, UI, 테스트 담당을 정합니다."],
  ["컨트롤 타워에서 작업 요청", "메인 채팅에 원하는 기능을 입력하세요. /fun이 요구사항과 완료 기준을 정리해 담당 AI에 전달합니다. 역할 설정에서 한도 소진 시 대체 AI도 지정할 수 있습니다."],
  ["AI 대화·작업 기록·알림", "오른쪽 AI 로고를 누르면 해당 AI의 실제 작업 로그와 대화가 열립니다. Workflow 보기에서 테스트·복원·변경 파일을 확인하고, 상단 종 버튼에서 알림을 관리하세요."],
];
const tourTargets = ["#new-project", "#open-roles", "#planner-input", "#desk-agents"];
let tourStep = 0;
function showTourStep() {
  document.querySelector(".tour-target")?.classList.remove("tour-target");
  $(tourTargets[tourStep])?.classList.add("tour-target");
  const [title, detail] = tourSteps[tourStep];
  $("#tour-count").textContent = `HANDSOFF GUIDE · ${tourStep + 1} / ${tourSteps.length}`;
  $("#tour-title").textContent = title;
  $("#tour-detail").textContent = detail;
  $("#tour-next").textContent = tourStep === tourSteps.length - 1 ? "마치기" : "다음 →";
}
function startTour() {
  tourStep = 0;
  showTourStep();
  $("#first-run-tour").showModal();
  $("#tour-next").focus();
}
function finishTour() {
  document.querySelector(".tour-target")?.classList.remove("tour-target");
  localStorage.setItem("tower-tour-v1", "complete");
  $("#first-run-tour").close();
  if (!preferences?.onboardingComplete) $("#settings-dialog").showModal();
}
$("#tour-next").addEventListener("click", () => {
  if (tourStep === tourSteps.length - 1) finishTour();
  else {
    tourStep++;
    showTourStep();
  }
});
$("#tour-skip").addEventListener("click", finishTour);
$("#first-run-tour").addEventListener("cancel", (event) => {
  event.preventDefault();
  finishTour();
});
$("#replay-tour").addEventListener("click", () => {
  $("#guide-dialog").close();
  startTour();
});
$("#open-guide").addEventListener("click", () =>
  $("#guide-dialog").showModal(),
);
$("#close-guide").addEventListener("click", () => $("#guide-dialog").close());
function renderDelivery(result) {
  missionDelivery = result;
  refreshMission();
  $("#services-result").textContent = result
    ? ["로컬 작업 완료", ({ github: "GitHub 실패", vercel: "Vercel 실패", snapshot: "릴리스 준비 실패" })[result.failedService], result.message, result.github?.url, result.vercel?.url]
        .filter(Boolean)
        .join(" · ")
    : "";
  $("#retry-delivery").hidden =
    !result || !["failed", "running"].includes(result.status);
  $("#retry-delivery").textContent = result?.failedService === "github" ? "GitHub 푸시 다시 시도" : result?.failedService === "vercel" ? "Vercel 상태 확인·재시도" : "릴리스 다시 시도";
  if (result?.pending) showReleaseApproval(result.pending);
}

let releaseApproval;
function showReleaseApproval(pending) {
  const dialog = $("#release-approval");
  if (dialog.open && releaseApproval?.id === pending.id) return;
  releaseApproval = { id: pending.id, projectId: projectData.activeId };
  $("#release-approval-title").textContent = `${pending.action}할까요?`;
  $("#release-approval-target").textContent =
    `${pending.projectTitle} → ${pending.target}`;
  $("#release-remember").checked = false;
  $("#release-remember-label").textContent =
    pending.service === "github"
      ? "이 프로젝트에서 다음부터 묻지 않고 커밋·푸시하기"
      : "이 프로젝트에서 다음부터 묻지 않고 배포하기";
  if (!dialog.open) dialog.showModal();
}

for (const yes of [false, true]) {
  $(yes ? "#release-yes" : "#release-no").addEventListener(
    "click",
    async () => {
      if (!releaseApproval) return;
      const { id, projectId } = releaseApproval;
      releaseApproval = null;
      const remember = yes && $("#release-remember").checked;
      $("#release-approval").close();
      try {
        await call(api.servicesAnswer(projectId, { id, yes, remember }));
      } catch (error) {
        toast(error.message, "error");
      }
    },
  );
}

let servicesProjectId;
async function loadServices() {
  const id = servicesProjectId;
  const { accounts, config, name, result, reconnectRequired } = await call(api.servicesStatus(id));
  if (id !== servicesProjectId) return;
  for (const [service, status] of Object.entries(accounts)) {
    $(`#service-${service}`).textContent =
      status.waiting ? "브라우저 로그인 대기 중…" : status.account ??
      (status.installed ? "로그인 필요" : "공식 CLI 설치 필요");
    $(`[data-service-login="${service}"]`).disabled = !status.installed || Boolean(status.waiting);
  }
  $("#service-auto-github").checked = config?.github ?? false;
  $("#service-auto-vercel").checked = config?.vercel ?? false;
  $("#service-repo-name").value = config?.name || "";
  $("#service-repo-name").placeholder =
    config?.resolvedName || "AI가 이름 제안 · 예: " + name;
  $("#service-scope").value = config?.scope || accounts.vercel.account || "";
  $("#service-target").value = config?.target || name;
  $("#service-production").checked = config?.production ?? false;
  $("#service-supabase-ref").value = config?.supabaseRef ?? "";
  $("#supabase-connection-hint").textContent = accounts.supabase.account
    ? "Supabase 연결 확인됨 · 프로젝트 참조 ID는 별도로 관리합니다."
    : accounts.supabase.installed ? "Supabase 프로젝트 목록을 확인하지 못했습니다. 로그인·프로젝트 접근 권한·네트워크를 확인한 뒤 연결 상태를 다시 확인하세요."
      : "Supabase 연결을 확인하려면 공식 CLI를 설치하세요.";
  renderApprovalPolicy(config);
  renderDelivery(result);
  if (reconnectRequired) $("#services-result").textContent = "이 PC에서 이전 배포 설정을 사용할 수 없습니다. 현재 계정으로 대상과 승인 옵션을 다시 저장하세요.";
}

function renderApprovalPolicy(config) {
  const automatic = [
    config?.always?.github && "GitHub",
    config?.always?.vercel && "Vercel",
  ].filter(Boolean);
  $("#service-approval-policy").textContent = automatic.length
    ? `${automatic.join(" · ")} 자동 승인 중 · 배포 대상이 바뀌면 다시 확인합니다.`
    : "검증이 끝나면 서비스마다 실행 여부를 확인합니다.";
  $("#reset-release-approval-label").hidden = !automatic.length;
  $("#reset-release-approval").checked = false;
}

$("#open-services").addEventListener("click", () => {
  const project = projectData?.items.find(
    (row) => row.id === projectData.activeId,
  );
  if (!project) return;
  servicesProjectId = project.id;
  $("#services-project").textContent = project.title;
  $("#save-services").disabled = true;
  $("#services-dialog").showModal();
  $("#refresh-services").click();
});
$("#close-services").addEventListener("click", () =>
  $("#services-dialog").close(),
);
$("#refresh-services").addEventListener("click", () =>
  busy($("#refresh-services"), "확인 중…", async () => {
    $("#save-services").disabled = true;
    await loadServices();
    $("#save-services").disabled = false;
  }),
);
for (const button of document.querySelectorAll("[data-service-login]")) {
  button.addEventListener("click", () =>
    busy(button, "여는 중…", async () => {
      await call(api.servicesLogin(button.dataset.serviceLogin));
      $("#services-result").textContent = "공식 브라우저 로그인 중 · 완료하면 계정 연결을 자동 확인합니다.";
    }).then(async () => {
      const { accounts } = await call(api.servicesStatus(servicesProjectId));
      const status = accounts[button.dataset.serviceLogin];
      button.disabled = !status.installed || Boolean(status.waiting);
    }).catch((error) => toast(error.message, "error")),
  );
}
$("#services-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void busy($("#save-services"), "저장 중…", async () => {
    try {
      const config = await call(
        api.servicesSave(servicesProjectId, {
          github: $("#service-auto-github").checked,
          vercel: $("#service-auto-vercel").checked,
          name: $("#service-repo-name").value,
          scope: $("#service-scope").value,
          target: $("#service-target").value,
          production: $("#service-production").checked,
          supabaseRef: $("#service-supabase-ref").value,
          resetApproval: $("#reset-release-approval").checked,
        }),
      );
      $("#services-result").textContent =
        "저장했습니다. 다음 작업부터 적용합니다.";
      renderApprovalPolicy(config);
    } catch (error) {
      $("#services-result").textContent = error.message;
    }
  });
});
$("#retry-delivery").addEventListener("click", () =>
  busy($("#retry-delivery"), "다시 시도 중…", async () => {
    try {
      await call(api.servicesRetry(servicesProjectId));
    } catch (error) {
      $("#services-result").textContent = error.message;
    }
  }),
);
const prerequisiteRows = new Map();
const prerequisiteWatcher = createPrerequisiteWatch({
  scan: tools => call(api.prerequisites({ passive: true, tools })),
  render: renderPrerequisites,
  becameReady: () => refreshStatus().catch(() => {}),
  failed: () => { $('#prerequisites-status').textContent = '자동 확인을 다시 시도합니다. ‘설치 후 다시 확인’으로 직접 확인할 수도 있어요.'; },
  visible: () => $('#prerequisites-dialog').open && !document.hidden,
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void prerequisiteWatcher.check(); });
function showPrerequisites(report) {
  if (!$('#prerequisites-dialog').open) $('#prerequisites-dialog').showModal();
  prerequisiteWatcher.open(report);
}
function renderPrerequisites(report, { intents, checking }) {
  const list = $('#prerequisites-list');
  const missing = report.rows.filter(row => row.required && row.state !== 'ready');
  const summary = $('#prerequisites-required');summary.dataset.ready = String(!missing.length);
  summary.textContent = missing.length ? `설치를 진행해주세요. ${missing.map(row => row.label).join(' · ')} 준비가 끝나야 작업을 시작할 수 있습니다. 설치 안내를 닫아도 AI 작업은 차단됩니다.` : '필수 프로그램 준비 완료. 이 창을 닫고 작업을 요청하세요.';
  $('#prerequisites-status').textContent = `${report.platform} · ${report.arch} · ${checking ? '실행 가능 여부 확인 중…' : '설치를 마치면 자동으로 확인해요. 창으로 돌아오면 즉시 다시 확인합니다.'}`;
  const labels = { ready: '준비됨', missing: '설치 필요', installing: '설치 중…', outdated: '24 이상으로 업데이트', unknown: '실행 확인 필요', 'npm-missing': 'npm 설치 확인 필요', 'not-running': 'Docker 설치됨 · 엔진 시작 필요', 'image-missing':'엔진 준비됨 · 격리 이미지 준비 필요' };
  for (const row of report.rows) {
    const known = prerequisiteRows.get(row.id);
    let view = known;
    if (!view) {
    const item = document.createElement('div'); item.className = 'prerequisite-row'; item.dataset.tool = row.id;
    const title = document.createElement('div'), name = document.createElement('span'), purpose = document.createElement('small'); purpose.className = 'prerequisite-purpose'; title.append(name, purpose);
    const state = document.createElement('div'); state.className = 'prerequisite-state';
    const badge = document.createElement('span'); badge.className = 'prerequisite-badge';
    const stateText = document.createElement('span'), progress = document.createElement('small'); progress.setAttribute('role', 'status'); state.append(stateText, progress);
    const button = document.createElement('button'); button.type = 'button';
    button.addEventListener('click', () => busy(button, '여는 중…', () => item.dataset.state === 'ready'
      ? call(api.openInstallSite(row.id)) : prerequisiteWatcher.installing(row.id, () => call(api.openInstallSite(row.id)))));
    const actions = document.createElement('div'); actions.className = 'prerequisite-actions'; actions.append(badge, button);
    item.append(title, state, actions); list.append(item);
    view = { item, name, purpose, state, badge, stateText, progress, button }; prerequisiteRows.set(row.id, view);
    }
    view.item.dataset.state = row.state; view.name.textContent = row.label; view.purpose.textContent = row.purpose;
    view.state.dataset.ready = String(row.state === 'ready'); view.badge.dataset.required = String(row.required); view.badge.textContent = row.required ? '필수' : '선택';
    const phase = intents.get(row.id);
    view.stateText.textContent = (labels[row.state] ?? '확인 필요') + (row.version ? ` · ${row.version}` : '');
    view.progress.textContent = row.state === 'ready' ? '' : phase === 'opening' ? '설치 안내 여는 중…'
      : checking && (row.required || phase) ? '설치·실행 확인 중…' : phase ? '다운로드·설치 대기 중 · 완료 여부 자동 확인' : '';
    view.progress.hidden = !view.progress.textContent;
    if (!view.button.disabled) view.button.textContent = row.state === 'ready' ? '공식 안내' : '설치 안내 열기';
  }
  for (const [id, view] of prerequisiteRows) if (!report.rows.some(row => row.id === id)) { view.item.remove(); prerequisiteRows.delete(id); }
  $('#continue-prerequisites').textContent = missing.length ? '설정·연결만 확인하기' : '준비 완료 · 시작하기';
}
function closePrerequisites() {
  prerequisiteWatcher.close();
  sessionStorage.setItem('tower-setup-seen', '1'); $('#prerequisites-dialog').close();
  if (!localStorage.getItem('tower-tour-v1')) startTour();
}
$('#close-prerequisites').addEventListener('click', closePrerequisites);
$('#continue-prerequisites').addEventListener('click', closePrerequisites);
$('#prerequisites-dialog').addEventListener('cancel', event => { event.preventDefault(); closePrerequisites(); });
for (const selector of ['#open-prerequisites', '#open-prerequisites-header']) {
  const button = $(selector);
  button.addEventListener('click', () => busy(button, '확인 중…', async () => showPrerequisites(await call(api.prerequisites()))));
}
$('#recheck-prerequisites').addEventListener('click', () => busy($('#recheck-prerequisites'), '공구함 확인 중…', async () => showPrerequisites(await call(api.prerequisites()))));
$('#update-layout').addEventListener('click', () => busy($('#update-layout'), '구조안 정리 중…', async () => { await call(api.reviseLayout(projectData.activeId, $('#image-prompt').value, currentConversation?.id)); renderImage(); }));
await initialize();
