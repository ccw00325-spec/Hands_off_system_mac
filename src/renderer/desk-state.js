import { teamFor, validateTeam } from "../core/team.js";
import { missionState } from "./mission-state.js";

export function displayedTeam(run, configured = [], conversation = null) {
  const active = [
    "planning",
    "building",
    "testing",
    "validating",
    "reviewing",
    "repairing",
    "final_review",
    "awaiting_design",
  ].includes(run?.status);
  const same =
    run?.options?.team &&
    configured.length &&
    JSON.stringify(validateTeam(run.options.team)) ===
      JSON.stringify(validateTeam(configured));
  const useRun = run?.options?.team && (active || same || !configured.length);
  const team = useRun ? run.options.team : configured;
  if (!team.length) return [];
  const options = { ...(useRun ? run.options : {}), team };
  if(conversation?.routing?.autoFallback===true)options.autoFallback=true;
  if (conversation?.routing?.teamKey === JSON.stringify(validateTeam(team)))
    options.runtimeRoutes = {
      ...options.runtimeRoutes,
      ...conversation.routing.runtimeRoutes,
    };
  return teamFor(options).map((agent) => ({
    ...agent,
    ...(options.runtimeRoutes?.[agent.id]
      ? {
          usingFallback: true,
          primaryProvider: team.find((row) => row.id === agent.id).provider,
        }
      : {}),
  }));
}
export function agentRows(run, team, connections = {}) {
  const verified = missionState(run, team).done;
  const states = {
    pending: "대기",
    working: "진행 중",
    reported: verified ? "완료" : "구현 완료",
    failed: "확인 필요",
    blocked: "진행 차단",
    cancelled: "중지됨",
  };
  return team.map((agent, index) => {
    const tasks = (run?.tasks ?? [])
      .filter((task) => task.owner === agent.id)
      .map((task) => ({
        id: task.id,
        title: task.title || task.id,
        status: task.status,
        label: states[task.status] ?? "대기",
        provider: task.executedProvider ?? agent.provider,
      }));
    if (!index) {
      const entries = [];
      if (run?.spec)
        entries.push({
          id: "controller-spec",
          title: "기능 명세 정리",
          status: "reported",
          label: "완료",
        });
      const phase = {
        planning: ["요구사항 정리", "working", "진행 중"],
        awaiting_design: ["UI 시안 승인", "pending", "확인 대기"],
        reviewing: ["변경 코드 검토", "working", "진행 중"],
        final_review: ["최종 교차 검토", "working", "진행 중"],
        repairing: ["수정 결과 취합", "working", "진행 중"],
        validating: ["실행 검증", "working", "진행 중"],
        completed: [
          "최종 검토",
          verified ? "reported" : "blocked",
          verified ? "완료" : "재검증 필요",
        ],
        needs_attention: ["중단 원인 확인", "failed", "확인 필요"],
        awaiting_validation: ["실행 검증", "pending", "확인 대기"],
        needs_input: ["추가 답변", "pending", "답변 대기"],
        cancelled: ["작업", "cancelled", "중지됨"],
        interrupted: ["이전 작업", "cancelled", "중단됨"],
      }[run?.status] ?? ["작업 결과 취합", "pending", "대기"];
      if (run && !(['reviewing','final_review'].includes(run.status)&&run.reviewChain?.length))
        entries.push({
          id: "controller-phase",
          title: phase[0],
          status: phase[1],
          label: phase[2],
        });
      tasks.unshift(...entries);
    }
    const review=run?.reviewChain?.find(step=>step.actor===agent.id);
    if(review)tasks.push({id:'review-chain',title:agent.id==='gpt'?'컨트롤 타워 최종 검토':'순차 디버깅·코드 검토',
      status:({pending:'pending',working:'working',passed:'reported',changes:'failed',blocked:'blocked'})[review.status]??'pending',
      label:({pending:'대기',working:'검토 중',passed:'OK',changes:'수정 필요',blocked:'테스트 확인 필요'})[review.status]??'대기',provider:review.provider});
    const working = tasks.filter((task) => task.status === "working");
    const recent = [...new Set([...tasks.slice(-2), ...working])];
    return {
      ...agent,
      connected: !!connections[agent.provider]?.connected,
      switched: !!run?.options?.runtimeRoutes?.[agent.id],
      usage:run?.usage?.byPanel?.[agent.id],
      tasks,
      recent,
      older: tasks.filter((task) => !recent.includes(task)),
    };
  });
}
