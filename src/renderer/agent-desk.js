import {recoveryActions} from './auth-recovery.js';
import { PROVIDERS, CAPABILITIES, teamFor } from "../core/team.js";
import { agentRows } from "./desk-state.js";
import { providerIcon } from "./provider-icon.js";
import {modelUsageLabel} from '../core/model-usage.js';
const $ = (selector) => document.querySelector(selector);
const node = (tag, text, cls) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (cls) item.className = cls;
  return item;
};
export function createAgentDesk({ onAction,onLogin,onChange }) {
  let input = {},
    signature = "",
    context = "",
    opened = null,
    activeTerminal = null,
    returnFocus = null,
    openedTask = null;
  const view = $("#workspace-view"),
    layout = node("section", undefined, "desk-layout");
  const sidebar = $(".project-sidebar");
  sidebar.prepend($("#new-project"));
  const sidebarActions = node("div", undefined, "desk-sidebar-actions"),
    connect = node("button", "계정 연결");
  connect.type = "button";
  connect.onclick = () => onAction("connections");
  sidebarActions.append($("#open-services"), connect);
  sidebar.querySelector("footer").before(sidebarActions);
  layout.id = "desk-layout";
  const chat = node("div", undefined, "desk-chat"),
    gutter = node("div", undefined, "desk-gutter"),
    rail = node("section", undefined, "desk-rail");
  rail.setAttribute("aria-label", "역할별 AI와 작업 기록");
  const header = node("header"),
    title = node("h2", "연결된 AI"),
    cards = node("div", undefined, "desk-agents");
  cards.id = "desk-agents";
  header.append(title, $("#open-roles"));
  rail.append(
    header,
    cards,
    node(
      "p",
      "AI 로고를 누르면 해당 AI의 대화와 작업 로그가 열립니다.",
      "desk-hint",
    ),
  );
  const placeholder = node(
    "div",
    "컨트롤 타워 대화를 팝업에서 보고 있습니다.",
    "desk-controller-placeholder",
  );
  placeholder.hidden = true;
  const planner = $(".planner");
  chat.append(placeholder, planner);
  const summary = node("div", undefined, "desk-summary");
  summary.append($("#mission-summary"), $("#mission-primary"));
  planner.prepend(summary);
  const port = node("span", undefined, "desk-control-port");
  port.id = "desk-control-port";
  port.setAttribute("aria-hidden", "true");
  chat.append(port);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "desk-links";
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  layout.append(svg, chat, gutter, rail);
  view.prepend(layout);
  const workflow = $("#workflow-dialog-content");
  workflow.append(
    $("#mission-flow"),
    $("#mission-output"),
    $(".task-inspector"),
  );
  const store = node("div");
  store.id = "desk-panel-storage";
  store.hidden = true;
  store.append($(".workers"));
  view.append(store);
  const workflowButton = node(
    "button",
    "Workflow 보기",
    "desk-workflow-button",
  );
  workflowButton.id = "desk-workflow-open";
  workflowButton.type = "button";
  workflowButton.setAttribute("aria-haspopup", "dialog");
  workflowButton.onclick = () => openWorkflow();
  const restore = node("button", "체크포인트", "subtle");
  restore.id = "desk-checkpoints-open";
  restore.type = "button";
  restore.onclick = () => onAction("checkpoints");
  const status = node("span", undefined, "desk-run-status");
  status.append($("#run-state-dot"), $("#project-state"));
  const tools = node("div", undefined, "desk-project-tools");
  tools.append(status, workflowButton, restore);
  planner.querySelector(".panel-heading").append(tools);
  const homes = new Map();
  for (const id of ["gpt", "grok", "claude", "reviewer"]) {
    const terminal = id === "gpt" ? planner : $(`[data-agent-panel="${id}"]`);
    const marker = document.createComment("AI session home " + id);
    terminal.before(marker);
    homes.set(id, { terminal, marker });
  }
  const dialog = $("#agent-session-dialog");
  function restoreTerminal() {
    if (!activeTerminal) return;
    const home = homes.get(opened);
    home.marker.after(activeTerminal);
    activeTerminal = null;
    opened = null;
    placeholder.hidden = true;
    document.body.removeAttribute("data-open-agent");
  }
  dialog.addEventListener("close", () => {
    restoreTerminal();
    if (returnFocus?.isConnected) returnFocus.focus();
    document.dispatchEvent(new Event("desk-dialog-closed"));
  });
  $("#close-agent-session").onclick = () => dialog.close();
  $("#close-workflow-dialog").onclick = () => $("#workflow-dialog").close();
  $("#workflow-dialog").addEventListener("close", () => {
    workflowButton.focus();
    document.dispatchEvent(new Event("desk-dialog-closed"));
  });
  function openWorkflow() {
    if (!$("#workflow-dialog").open) $("#workflow-dialog").showModal();
    document.dispatchEvent(new Event("desk-workflow-open"));
  }
  function taskDetail(taskId) {
    const detail = $("#desk-popup-task"),
      task = input.run?.tasks?.find((row) => row.id === taskId);
    detail.hidden = !task;
    detail.replaceChildren();
    if (!task) return;
    detail.append(node("strong", task.title || task.id));
    const paths =
      task.report?.changed?.map((row) =>
        typeof row === "string" ? row : row.path,
      ) ??
      task.writePaths ??
      [];
    detail.append(
      node(
        "p",
        paths.length
          ? "변경 파일 · " + paths.join(" · ")
          : "변경 파일 보고 대기",
        "hint",
      ),
    );
    if (task.report?.summary) detail.append(node("p", task.report.summary));
    const criteria = node("details"),
      list = node("ul");
    criteria.append(node("summary", "완료 기준"));
    for (const item of task.acceptanceCriteria ?? [])
      list.append(node("li", item));
    criteria.append(list);
    detail.append(criteria);
  }
  function openAgent(actor, taskId = null) {
    const current = input.team?.find((row) => row.id === actor);
    const agent =
      current ??
      (input.run?.options?.team
        ? teamFor(input.run.options).find((row) => row.id === actor)
        : null);
    if (!agent) return;
    dialog.dataset.historical = String(!current);
    if (opened !== actor) {
      restoreTerminal();
      opened = actor;
      activeTerminal = homes.get(actor).terminal;
      $("#agent-session-content").replaceChildren(activeTerminal);
      placeholder.hidden = actor !== "gpt";
    }
    document.body.dataset.openAgent = actor;
    activeTerminal.hidden = false;
    openedTask = taskId;
    const label =
      actor === "gpt"
        ? "컨트롤 타워 · 같은 대화"
        : agent.roles.map((role) => CAPABILITIES[role]).join(" · ");
    $("#agent-session-title").replaceChildren(
      providerIcon(agent.provider, 26),
      node("span", `${PROVIDERS[agent.provider]} · ${label}`),
    );
    taskDetail(taskId);
    if (!dialog.open) {
      returnFocus = document.activeElement;
      dialog.showModal();
    }
    const inputBox =
      actor === "gpt" ? $("#planner-input") : $("#" + actor + "-input");
    inputBox?.focus({ preventScroll: true });
  }
  let queued = false;
  function redraw() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const bounds = layout.getBoundingClientRect();
      if (!bounds.width) return;
      svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
      svg.replaceChildren();
      const start = port.getBoundingClientRect();
      for (const agent of input.team ?? []) {
        const target = $(`[data-desk-agent="${agent.id}"]`);
        if (!target) continue;
        const end = target.getBoundingClientRect();
        const x1 = start.left + start.width / 2 - bounds.left,
          y1 = start.top + start.height / 2 - bounds.top,
          x2 = end.left - bounds.left,
          y2 = end.top + end.height / 2 - bounds.top;
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.dataset.actor = agent.id;
        path.dataset.provider = agent.provider;
        path.setAttribute(
          "d",
          `M${x1},${y1} C${x1 + (x2 - x1) * 0.48},${y1} ${x1 + (x2 - x1) * 0.48},${y2} ${x2},${y2}`,
        );
        path.setAttribute(
          "class",
          agent.id === "gpt" ? "desk-same-session" : "desk-route",
        );
        svg.append(path);
        if (agent.id !== "gpt") {
          const dot = document.createElementNS(svg.namespaceURI, "circle");
          dot.setAttribute("cx", String(x2));
          dot.setAttribute("cy", String(y2));
          dot.setAttribute("r", "3");
          dot.dataset.provider = agent.provider;
          svg.append(dot);
        }
      }
    });
  }
  const observer = new ResizeObserver(redraw);
  observer.observe(layout);
  observer.observe(chat);
  observer.observe(rail);
  window.addEventListener("resize", redraw);
  function historyItem(task, agent) {
    const button = node("button", undefined, "desk-task");
    button.type = "button";
    button.dataset.state = task.status;
    button.dataset.task = task.id;
    const status = node(
      "span",
      task.status === "working"
        ? "◉"
        : task.status === "reported"
          ? "✓"
          : task.status === "failed" || task.status === "blocked"
            ? "!"
            : "○",
      "desk-task-symbol",
    );
    status.setAttribute("aria-hidden", "true");
    button.append(
      status,
      node("span", task.title),
      node(
        "small",
        task.label +
          (task.provider && task.provider !== agent.provider
            ? " · " + PROVIDERS[task.provider]
            : ""),
      ),
    );
    if (task.provider)
      button.title = `${PROVIDERS[task.provider]} · ${task.title} · ${task.label}`;
    button.onclick = () => openAgent(agent.id, task.id);
    return button;
  }
  return {
    openAgent,
    openWorkflow,
    redraw,
    update(value) {
      input = value;
      const nextContext = `${value.projectId}:${value.conversationId}`;
      if (context !== nextContext) {
        context = nextContext;
        if (dialog.open) dialog.close();
        restoreTerminal();
        if ($("#workflow-dialog").open) $("#workflow-dialog").close();
      }
      const rows = agentRows(value.run, value.team ?? [], value.connections);
      title.textContent = `연결된 AI · ${rows.length}`;
      layout.dataset.count = String(rows.length);
      workflowButton.disabled = !value.run;
      workflowButton.textContent = value.run
        ? "Workflow 보기"
        : "Workflow · 작업 대기";
      const next = JSON.stringify(rows);
      if (signature !== next) {
        signature = next;
        const focused = cards.querySelector(":focus")?.dataset.deskAgent;
        cards.replaceChildren(
          ...rows.map((agent) => {
            const card = node("article", undefined, "desk-agent-card");
            card.dataset.actor = agent.id;
            card.dataset.provider = agent.provider;
            const identity = node("div", undefined, "desk-agent-identity"),
              logo = node("button", undefined, "desk-agent-logo");
            logo.type = "button";
            logo.dataset.deskAgent = agent.id;
            logo.setAttribute(
              "aria-label",
              `${PROVIDERS[agent.provider]} ${agent.roles.map((role) => CAPABILITIES[role]).join("/")} 대화 열기`,
            );
            logo.setAttribute("aria-haspopup", "dialog");
            logo.append(providerIcon(agent.provider, 40));
            logo.onclick = () => openAgent(agent.id);
            identity.append(
              logo,
              node("strong", PROVIDERS[agent.provider]),
              node(
                "small",
                agent.id === "gpt"
                  ? "컨트롤 타워 · 같은 대화"
                  : agent.roles.map((role) => CAPABILITIES[role]).join(" / "),
              ),
            );
            const model = node(
              "small",
              agent.modelId || "현재 AI 계정의 자동 선택 모델",
              "desk-agent-model",
            );
            model.title = agent.modelId || "현재 AI 계정의 자동 선택 모델";
            identity.append(model);
            const usage=node('div',undefined,'desk-model-usage');usage.dataset.modelUsage=agent.id;
            for(const item of Object.values(agent.usage?.models??{}))usage.append(node('small',modelUsageLabel(item)));
            if(!Object.keys(agent.usage?.models??{}).length)usage.append(node('small','사용량 · 요청 완료 시 공급자 집계 반영'));
            identity.append(usage);
            const switched = agent.usingFallback;
            if (switched)
              identity.append(
                node(
                  "span",
                  `${PROVIDERS[agent.primaryProvider]} → 대체 연결`,
                  "desk-fallback-tag",
                ),
              );
            identity.append(
                node(
                  "span",
                  agent.connected ? (agent.provider==='grok'?"Cursor 로그인됨":"연결됨") : "연결 확인 필요",
                  agent.connected ? "desk-connected" : "desk-disconnected",
                ),
              );
            const history = node("div", undefined, "desk-agent-history");
            for (const item of agent.recent)
              history.append(historyItem(item, agent));
            if (!agent.tasks.length)
              history.append(
                node(
                  "p",
                  agent.connected
                    ? "작업 배정을 기다립니다."
                    : "계정 연결을 확인하세요.",
                  "hint",
                ),
              );
            if (agent.older.length) {
              const details = node("details", undefined, "desk-older-tasks");
              details.append(
                node("summary", `이전 작업 ${agent.older.length}개`),
              );
              const list = node("div");
              for (const item of agent.older)
                list.append(historyItem(item, agent));
              details.append(list);
              history.append(details);
            }
            if (agent.fallback && !switched)
              history.append(
                node(
                  "small",
                  `한도 소진 시 ${PROVIDERS[agent.fallback.provider]}`,
                  "desk-backup-hint",
                ),
              );
            if(!agent.connected)history.prepend(recoveryActions(agent,{login:onLogin,change:onChange}));
            card.append(identity, history);
            return card;
          }),
        );
        if (focused)
          $(`[data-desk-agent="${focused}"]`)?.focus({ preventScroll: true });
        redraw();
      }
      if (opened) {
        const current = value.team.find((row) => row.id === opened),
          agent =
            current ??
            (value.run?.options?.team
              ? teamFor(value.run.options).find((row) => row.id === opened)
              : null);
        if (!agent) {
          dialog.close();
          restoreTerminal();
        } else {
          activeTerminal.hidden = false;
          dialog.dataset.historical = String(!current);
          $("#agent-session-title").replaceChildren(
            providerIcon(agent.provider, 26),
            node(
              "span",
              `${PROVIDERS[agent.provider]} · ${!current ? "이전 실행 기록 · 읽기 전용" : opened === "gpt" ? "컨트롤 타워 · 같은 대화" : agent.roles.map((role) => CAPABILITIES[role]).join(" / ")}`,
            ),
          );
          taskDetail(openedTask);
        }
      }
    },
  };
}
