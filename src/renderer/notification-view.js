const $ = (selector) => document.querySelector(selector);
const node = (tag, text, cls) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (cls) item.className = cls;
  return item;
};
export function createNotifications(api, onAction) {
  let items = [],
    queue = Promise.resolve(),
    timer = null;
  const seen = new Set(),
    popover = $("#notification-popover"),
    toast = $("#toast");
  const unwrap = async (promise) => {
    const result = await promise;
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  function operation(action) {
    const promise = queue.then(async () => {
      items = await action();
      render();
    });
    queue = promise.catch(() => {});
    return promise;
  }
  function dismiss() {
    clearTimeout(timer);
    if (toast.matches(":popover-open")) toast.hidePopover();
    toast.hidden = true;
  }
  function activate(item) {
    if (popover.matches(":popover-open")) popover.hidePopover();
    dismiss();
    void onAction(item);
  }
  function show(item) {
    dismiss();
    toast.replaceChildren(node("p", item.message));
    toast.className = "toast " + (item.type ?? "");
    const close = node("button", "×", "toast-dismiss");
    close.type = "button";
    close.setAttribute("aria-label", "화면 알림 닫기");
    close.onclick = dismiss;
    toast.append(close);
    if (item.action) {
      const action = node(
        "button",
        {
          design: "시안 확인",
          settings: "설정 확인",
          connections: "계정 연결",
          workflow: "Workflow 보기",
          checkpoints: "체크포인트",
          delivery: "전송 상태",
          questions: '질문에 답변하기',
          prerequisites: '필수 프로그램 설치',
        }[item.action],
      );
      action.type = "button";
      action.onclick = () => activate(item);
      toast.append(action);
    }
    toast.append(
      node(
        "span",
        "약 10초 후 닫힘 · 기록은 종 버튼에서 확인",
        "toast-countdown",
      ),
      node("span", undefined, "toast-timer"),
    );
    toast.hidden = false;
    toast.showPopover();
    timer = setTimeout(dismiss, 10000);
    $("#footer-status").textContent = item.message;
  }
  function render() {
    const unread = items.filter((item) => !item.read).length;
    $("#notification-count").hidden = !unread;
    $("#notification-count").textContent = unread > 99 ? "99+" : String(unread);
    $("#notification-bell").setAttribute(
      "aria-label",
      `알림 기록 · 읽지 않은 알림 ${unread}개`,
    );
    const list = $("#notification-items");
    list.replaceChildren();
    for (const item of items) {
      const row = node("article", undefined, "notification-item");
      row.dataset.type = item.type;
      row.tabIndex = 0;
      row.append(node("p", item.message));
      const time = node("time", new Date(item.at).toLocaleString("ko-KR"));
      row.append(time);
      if (item.action) {
        const action = node(
          "button",
          {
            design: "시안 확인",
            settings: "설정 확인",
            connections: "계정 연결",
            workflow: "작업 확인",
            checkpoints: "복원 기록",
            delivery: "전송 상태",
            questions: '질문에 답변하기',
            prerequisites: '필수 프로그램 설치',
          }[item.action],
        );
        action.type = "button";
        action.onclick = () => activate(item);
        row.append(action);
      }
      const remove = node("button", undefined, "notification-delete");
      remove.type = "button";
      remove.setAttribute("aria-label", "이 알림 삭제");
      remove.title = "이 알림 삭제";
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("width", "17");
      icon.setAttribute("height", "17");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(icon.namespaceURI, "path");
      path.setAttribute(
        "d",
        "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7m4-7v7",
      );
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.7");
      icon.append(path);
      remove.append(icon);
      remove.onclick = () =>
        void operation(() => unwrap(api.removeNotification(item.id)));
      row.append(remove);
      list.append(row);
    }
    if (!items.length) list.append(node("p", "알림이 없습니다.", "hint"));
    $("#clear-notifications").disabled = !items.length;
  }
  $("#close-notifications").onclick = () => popover.hidePopover();
  $("#clear-notifications").onclick = () =>
    void operation(() => unwrap(api.clearNotifications()));
  popover.addEventListener("toggle", (event) => {
    if (event.newState === "open")
      void operation(() => unwrap(api.readNotifications()));
  });
  function push(message, type = "", meta = {}) {
    const item = { message: String(message).slice(0, 3000), type, ...meta };
    show(item);
    if (api) void operation(() => unwrap(api.addNotification(item)));
  }
  return {
    push,
    init() {
      return api
        ? operation(() => unwrap(api.notifications()))
        : Promise.resolve();
    },
    observe(run, scope) {
      if (!run) return;
      const notices = [];
      if (run.status === "awaiting_design" && run.design?.status === "ready")
        notices.push({
          key: `${run.id}:design:${run.design.artifactId || run.design.revisionId}`,
          message:
            "UI 시안이 준비됐어요. 확인 후 승인하거나 변경을 요청해 주세요.",
          action: "design",
        });
      if (
        [
          "needs_attention",
          "awaiting_validation",
          "needs_input",
          "completed",
        ].includes(run.status)
      )
        notices.push({
          key: run.status === 'needs_input' ? `${run.id}:input:${run.questionBatchId}` : `${run.id}:${run.status}:${run.round}`,
          message: run.events?.at(-1)?.message ?? run.status,
          action: run.status === 'needs_input' ? 'questions' : run.validation?.requiresConsent ? "settings" : "workflow",
          type:
            run.status === "completed"
              ? "success"
              : run.status === "needs_attention"
                ? "error"
                : "info",
        });
      for (const event of (run.events ?? [])
        .filter((event) => ["fallback", "report"].includes(event.activity))
        .slice(-8))
        notices.push({
          key: `${run.id}:${event.at}:${event.actor}:${event.activity}:${event.taskId ?? ""}`,
          message: event.message,
          action: "workflow",
        });
      for (const notice of notices) {
        if (seen.has(notice.key)) continue;
        seen.add(notice.key);
        if (seen.size > 1000) seen.delete(seen.values().next().value);
        push(notice.message, notice.type ?? "", { ...scope, ...notice });
      }
    },
  };
}
