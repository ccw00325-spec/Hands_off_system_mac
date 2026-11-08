import { testFailure } from "./test-failure.js";
import { applyBatch, markVerified } from "./checkpoints.js";
import { providerSnapshot, redact, redactData, secretFinding } from "./secrets.js";
import { randomUUID } from "node:crypto";
import { digest, relativeFile } from "./workspace.js";
import { PROVIDER_NAMES } from "./roles.js";
import { teamFor, agentLabel, agentOptions } from "./team.js";
import { compileFunPlan, skillHash } from "./fun-contract.js";
import { readFile } from "node:fs/promises";
import { runMutation } from "./mutation.js";
import { testPlanMarkdown } from "./test-plan.js";
import { stateHandoff, compactHandoff } from './handoff.js';
import { layoutPreview } from './layout-preview.js';
import { validateVisualReview } from './visual-review.js';
import { clarificationQuestions, clarificationAnswers } from './clarifications.js';
import { reviewOrder, orderDebugTasks, sortReviewAgents } from './review-order.js';

const ACTIVE = new Set([
  "testing",
  "planning",
  "awaiting_design",
  "building",
  "validating",
  "reviewing",
  "repairing",
  "final_review",
]);
const controllerName = (state) =>
  PROVIDER_NAMES[teamFor(state.options)[0].provider];
export function objectJSON(text) {
  const clean =
    typeof text === "string"
      ? text
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "")
      : "";
  try {
    const object = JSON.parse(clean);
    if (object && typeof object === "object" && !Array.isArray(object))
      return object;
  } catch {}
  throw new Error(
    "AI 응답이 정해진 JSON 형식이 아닙니다. 자동 적용을 중단했습니다.",
  );
}
export function validatePlan(plan, options = {}) {
  if (Array.isArray(plan.questions) && plan.questions.length)
    return { ...plan, tasks: [] };
  if (
    !Array.isArray(plan.tasks) ||
    !plan.tasks.length ||
    plan.tasks.length > 40 ||
    typeof plan.spec !== "string" ||
    plan.spec.length > 300000
  )
    throw new Error("기능 명세 또는 작업 목록이 불완전합니다.");
  const ids = new Set();
  const owners = options.team
    ? teamFor(options).map((agent) => agent.id)
    : ["grok", "claude"];
  for (const task of plan.tasks) {
    if (
      typeof task.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,60}$/.test(task.id) ||
      ids.has(task.id) ||
      !owners.includes(task.owner) ||
      typeof task.instructions !== "string" ||
      !task.instructions.trim() ||
      !Array.isArray(task.dependsOn) ||
      !Array.isArray(task.acceptanceCriteria) ||
      !task.acceptanceCriteria.length ||
      task.acceptanceCriteria.some(
        (value) => typeof value !== "string" || !value.trim(),
      )
    )
      throw new Error("작업의 담당자·완료 기준·의존 관계가 유효하지 않습니다.");
    for (const key of ["writePaths", "readPaths"]) {
      if (task[key] === undefined) continue;
      if (!Array.isArray(task[key]) || task[key].length > 60) throw new Error("작업 파일 범위가 올바르지 않습니다.");
      task[key] = [...new Set(task[key].map((path) => relativeFile(path).join("/")))];
    }
    ids.add(task.id);
  }
  const remaining = new Set(ids),
    finished = new Set();
  while (remaining.size) {
    const ready = plan.tasks.filter(
      (task) =>
        remaining.has(task.id) &&
        task.dependsOn.every((id) => finished.has(id)),
    );
    if (!ready.length)
      throw new Error("존재하지 않는 작업 의존성 또는 순환 의존성이 있습니다.");
    for (const task of ready) {
      remaining.delete(task.id);
      finished.add(task.id);
    }
  }
  return plan;
}
export function validateReview(review, tasks, ownership = {}) {
  if (!Array.isArray(review.issues) || typeof review.summary !== "string")
    throw new Error("검토 결과의 형식이 올바르지 않습니다.");
  for (const issue of review.issues) {
    const task = tasks.find((task) => task.id === issue.taskId);
    if (
      !task ||
      issue.owner !== task.owner ||
      typeof issue.description !== "string" ||
      !issue.description.trim()
    )
      throw new Error("검토 지적의 원래 작업 담당자를 확인할 수 없습니다.");
    if (
      issue.file &&
      ownership[issue.file] &&
      ownership[issue.file].taskId !== task.id
    )
      throw new Error(
        "파일 변경 기록과 검토 지적의 담당 작업이 일치하지 않습니다.",
      );
  }
  return review;
}

export class Workflow {
  constructor(
    workspace,
    providers,
    notify = () => {},
    validate = async () => ({ configured: false, passed: false }),
  ) {
    this.workspace = workspace;
    this.designGenerator = null;
    this.providers = providers;
    this.notify = notify;
    this.validate = validate;
    this.runs = new Map();
    this.starting = new Set();
  }
  isActive(projectId) {
    return (
      this.starting.has(projectId) ||
      ACTIVE.has(this.runs.get(projectId)?.state.status)
    );
  }
  async preflight(projectId, options) {
    if (
      !options ||
      typeof options.request !== "string" ||
      !options.request.trim() ||
      options.request.length > 16000
    )
      throw new Error("작업 요청을 1~16,000자로 입력하세요.");
    if (
      !Number.isInteger(options.maxRepairRounds) ||
      options.maxRepairRounds < 0 ||
      options.maxRepairRounds > 20
    )
      throw new Error("자동 수정 최대 횟수를 0~20 사이에서 직접 설정하세요.");
    await this.workspace.grant(projectId);
    for (const agent of teamFor(options))
      if (!(await this.providers[agent.id]?.ready(options)))
        throw new Error(
          `${options.team ? agentLabel(agent) : agent.id.toUpperCase()} 연결과 모델 설정을 먼저 완료하세요.`,
        );
  }
  async start(projectId, options) {
    if (this.isActive(projectId))
      throw new Error("이 프로젝트는 작업 중입니다. 먼저 중지하세요.");
    this.starting.add(projectId);
    try {
      await this.preflight(projectId, options);
      const grant = await this.workspace.grant(projectId);
      const state = {
        id: randomUUID(),
        projectId,
        grantId: grant.grantId,
        root: grant.root,
        request: redact(options.request),
        options: { ...structuredClone(options), request: redact(options.request) },
        status: "planning",
        batchRollback: true,
        round: 0,
        tasks: [],
        events: [],
        createdAt: new Date().toISOString(),
      };
      const run = {
        state,
        controller: new AbortController(),
        queue: Promise.resolve(),
      };
      this.runs.set(projectId, run);
      await this.record(run, "gpt", "요구사항과 기능 명세를 작성합니다.");
      for(const change of state.options.preflightSwitches??[])await this.record(run,change.actor,
        `${PROVIDER_NAMES[change.from]} 사용 한도 소진 → ${PROVIDER_NAMES[change.provider]}로 전환합니다. 같은 역할과 완료 기준을 유지합니다.`,
        {activity:"fallback",fromProvider:change.from,provider:change.provider});
      delete state.options.preflightSwitches;
      this.launch(run);
      return structuredClone(state);
    } finally {
      this.starting.delete(projectId);
    }
  }
  launch(run, verificationOnly = false) {
    const { state } = run;
    run.promise = (verificationOnly ? this.verifyAndRepair(run) : this.execute(run)).catch(async (error) => {
        const cancelled = run.controller.signal.aborted && !run.failure;
        state.status = cancelled ? "cancelled" : "needs_attention";
        for (const task of state.tasks)
          if (task.status === "working")
            task.status = cancelled ? "cancelled" : "failed";
          else if (task.status === "pending")
            task.status = cancelled ? "cancelled" : "blocked";
        if (
          state.testing &&
          ["writing", "running"].includes(state.testing.status)
        ) {
          state.testing.status = cancelled ? "cancelled" : "failed";
          state.testing.stale = true;
        }
        await this.record(
          run,
          "system",
          cancelled ? "사용자가 작업을 중지했습니다." : error.message,
        ).catch(() => {});
        this.notify({
          type: "workflow",
          projectId: state.projectId,
          state: structuredClone(state),
        });
      });
  }
  async answerQuestions(projectId, runId, batchId, answers, conversationId) {
    if (this.isActive(projectId)) throw new Error('다른 작업이 진행 중입니다. 질문 답변은 잠시 후 전송하세요.');
    this.starting.add(projectId);
    try {
      const state = await this.current(projectId, runId);
      const latest = await this.current(projectId);
      if (!state || latest?.id !== runId || state.status !== 'needs_input' || state.questionBatchId !== batchId ||
          state.options.conversationId !== conversationId)
        throw new Error('이미 답변했거나 현재 대화의 질문이 아닙니다. 질문을 다시 확인하세요.');
      const grant = await this.workspace.grant(projectId, state.grantId);
      if (grant.root !== state.root) throw new Error('작업 폴더 연결이 변경되었습니다.');
      const decisions = clarificationAnswers(clarificationQuestions(state.questions), answers);
      state.options.questionAnswers = [...(state.options.questionAnswers ?? []), { batchId, answers: decisions }];
      state.questions = [];
      state.questionBatchId = null;
      state.status = 'planning';
      state.answeredQuestionBatches = (state.answeredQuestionBatches ?? 0) + 1;
      const run = { state, controller: new AbortController(), queue: Promise.resolve() };
      this.runs.set(projectId, run);
      await this.record(run, 'gpt', '사용자 답변을 반영해 같은 작업의 명세를 이어서 작성합니다.', { answers: decisions });
      this.launch(run);
      return structuredClone(state);
    } finally { this.starting.delete(projectId); }
  }
  async record(run, actor, message, details = {}) {
    const operation = run.queue.then(async () => {
      const event = {
        at: new Date().toISOString(),
        actor,
        ...(actor !== "system" ? { provider: teamFor(run.state.options).find((agent) => agent.id === actor)?.provider } : {}),
        message: redact(message),
        ...redactData(details),
      };
      run.state.eventCount = (run.state.eventCount ?? 0) + 1;
      await this.workspace.write(
        run.state.projectId,
        `.control-tower/runs/${run.state.id}/events/${String(run.state.eventCount).padStart(6, "0")}.json`,
        JSON.stringify(event),
        { internal: true, grantId: run.state.grantId, newOnly: true },
      );
      run.state.events.push(event);
      run.state.events = run.state.events.slice(-150);
      const { state } = run;
      await this.workspace.write(
        state.projectId,
        `.control-tower/runs/${state.id}/state.json`,
        JSON.stringify(state, null, 2),
        { internal: true, grantId: state.grantId },
      );
      await this.workspace.write(
        state.projectId,
        ".control-tower/latest-run.json",
        JSON.stringify({ id: state.id }),
        { internal: true, grantId: state.grantId },
      );
      this.notify({
        type: "workflow",
        projectId: state.projectId,
        state: structuredClone(state),
      });
    });
    run.queue = operation.catch(() => {});
    return operation;
  }
  async callAgent(run, actor, action, context, admitted = false) {
    const { state } = run;
    const usage = state.usage ??= { calls: 0, byPanel: {} };
    const provider = teamFor(state.options).find((agent) => agent.id === actor)?.provider;
    let api = provider === "gpt" && state.options.gptSource === "api";
    const mayUseApi = state.options.gptSource === "api" && teamFor(state.options).some((agent) => agent.provider === "gpt" || agent.fallback?.provider === "gpt");
    if (mayUseApi && state.options.apiBudgetUsd > 0 && !admitted) {
      const operation = (run.apiQueue ?? Promise.resolve()).then(() => {
        context.signal.throwIfAborted();
        return this.callAgent(run, actor, action, context, true);
      });
      run.apiQueue = operation.catch(() => {});
      return operation;
    }
    const limit = [1, 2, 3, 4].includes(state.options.maxConcurrentAgents) ? state.options.maxConcurrentAgents : Infinity;
    while ((run.activeCalls ?? 0) >= limit) {
      await new Promise((resolve) => (run.callWaiters ??= []).push(resolve));
      if (context.signal.aborted) {
        run.callWaiters?.shift()?.();
        context.signal.throwIfAborted();
      }
    }
    context.signal.throwIfAborted();
    run.activeCalls = (run.activeCalls ?? 0) + 1;
    const panel = usage.byPanel[actor] ??= { calls: 0, input: 0, output: 0, measured: 0 };
    const started = Date.now();
    let measured = false, attempted = false, actualProvider = provider, actualModel, quotaTicket, actualCost;
    const onProviderAttempt = async ({ provider: next }) => {
      if (quotaTicket) await this.quota?.settle(quotaTicket, actualCost);
      quotaTicket = null; actualCost = undefined;
      if (attempted && api && !measured) usage.costUnknown = true;
      attempted = false;
      api = next === "gpt" && state.options.gptSource === "api";
      actualProvider = next;
      const routeOptions=agentOptions(state.options,actor);
      actualModel=({gpt:routeOptions.gptModel,claude:routeOptions.claudeModel,gemini:routeOptions.geminiModel,grok:routeOptions.grokRoute?.modelId})[next];
      measured = false;
      if (usage.calls >= (state.options.maxAgentCalls ?? Infinity))
        throw new Error("AI 호출 한도에 도달했습니다. 설정에서 한도를 확인한 뒤 새 작업을 시작하세요.");
      if (api && (state.options.apiBudgetUsd > 0 || state.options.dailyApiBudgetUsd > 0)) {
        const model = agentOptions(state.options, actor).gptModel;
        if (model !== state.options.apiRateModel || usage.costUnknown || (state.options.apiBudgetUsd > 0 && (usage.estimatedUsd ?? 0) >= state.options.apiBudgetUsd))
          throw new Error("GPT API 예산 한도 또는 모델 단가를 확인하세요.");
      }
      if (this.quota) quotaTicket = await this.quota.admit({ runId: state.id, options: state.options });
      attempted = true;
      usage.calls++;
      panel.calls++;
      panel.providers ??= {};
      panel.providers[next] = (panel.providers[next] ?? 0) + 1;
    };
    const onProviderSwitch = async (change) => {
      state.options.runtimeRoutes ??= {};
      state.options.runtimeRoutes[actor] = { provider: change.provider, ...(change.modelId ? { modelId: change.modelId } : {}) };
      if (run.ephemeral) await run.routeChanged?.();
      else await this.record(run, actor,
        `${PROVIDER_NAMES[change.from]} ${change.reason==="low_quota"?"잔여 한도 5% 이하":"사용 한도 소진"} → ${PROVIDER_NAMES[change.provider]}로 전환합니다. 현재 작업과 완료 기준을 유지합니다.`,
        { activity: "fallback", fromProvider: change.from, provider: change.provider, taskId: context.task?.id });
    };
    const onUsage = (input, output, model) => {
      if (measured || ![input, output].every((value) => Number.isSafeInteger(value) && value >= 0)) return;
      measured = true;
      panel.measured++;
      panel.input += input;
      panel.output += output;
      if (api && model && model === state.options.apiRateModel &&
          (state.options.apiInputRate > 0 || state.options.apiOutputRate > 0)) {
        const cost = (input * state.options.apiInputRate + output * state.options.apiOutputRate) / 1_000_000;
        usage.estimatedUsd = (usage.estimatedUsd ?? 0) + cost;
        actualCost = cost;
        panel.estimatedUsd = (panel.estimatedUsd ?? 0) + cost;
      } else if (api) usage.costUnknown = true;
      if (!api) actualCost = 0;
    };
    if (!run.ephemeral) this.notify({ type: "workflow", projectId: state.projectId, state: structuredClone(state) });
    try {
      const { snapshot, signal, options, designImage, ...rest } = context;
      const handoff = stateHandoff(state, actor, action, context);
      if (!run.ephemeral && state.id && state.grantId) {
        const sequence = (run.handoffSequence = (run.handoffSequence ?? 0) + 1);
        await this.workspace.write(state.projectId, `.control-tower/runs/${state.id}/handoffs/${sequence}-${actor}-${randomUUID()}.json`, JSON.stringify(handoff, null, 2), {internal:true, grantId:state.grantId, newOnly:true});
      }
      const payload = {
        ...redactData(rest), handoff: compactHandoff(redactData(rest), handoff), signal, designImage,
        snapshot: providerSnapshot(snapshot),
        options: { ...redactData(options), runtimeRoutes: state.options.runtimeRoutes ?? {}, exhaustedProviders: state.options.exhaustedProviders ??= [], cursorUiApproved: state.options.cursorUiApproved ??= [],
          onCursorUiApproved: async key=>{if(!state.options.cursorUiApproved.includes(key))state.options.cursorUiApproved.push(key);},
          onProviderExhausted: async provider=>{if(!state.options.exhaustedProviders.includes(provider))state.options.exhaustedProviders.push(provider);},
          onApiReservation: async amount => { if (quotaTicket) await this.quota.reserve(quotaTicket, amount, state.options); },
          onUsage, onProviderAttempt, onProviderSwitch },
      };
      // Plain providers used by embedders/tests do not implement the routing hooks.
      if (!this.providers[actor].routed) await onProviderAttempt({ provider });
      const result = await this.providers[actor][action](payload);
      if(result&&typeof result==="object"&&!Array.isArray(result)) {
        // Preserve proposed file bytes until the write guard can reject secrets.
        // Redacting them here would hide the finding and silently change code.
        const safeResult=action==="build"&&typeof result.summary==="string"
          ? {...result,summary:redact(result.summary)} : redactData(result);
        return { ...safeResult, executedProvider:actualProvider, ...(actualModel?{executedModel:actualModel}:{}) };
      }
      return redactData(result);
    } finally {
      if (quotaTicket) await this.quota?.settle(quotaTicket, actualCost);
      run.activeCalls--;
      run.callWaiters?.shift()?.();
      if (attempted && api && !measured) usage.costUnknown = true;
      panel.elapsedMs = (panel.elapsedMs ?? 0) + Date.now() - started;
      panel.lastProvider = actualProvider;
      if (!run.ephemeral) this.notify({ type: "workflow", projectId: state.projectId, state: structuredClone(state) });
    }
  }
  async reviseDesign(projectId, feedback, provider, conversationId, format) {
    const run = this.runs.get(projectId);
    if (run?.state.status !== "awaiting_design" ||
        conversationId !== run.state.options.conversationId)
      throw new Error("시안 승인을 기다리는 작업이 없습니다.");
    if (run.designBusy || !["pending", "ready", "error"].includes(run.state.design?.status))
      throw new Error("현재 시안을 변경할 수 없습니다.");
    if (typeof feedback !== "string" || feedback.length > 6000 || !["gpt", "gemini"].includes(provider))
      throw new Error("시안 요청 또는 모델을 확인하세요.");
    const { state } = run;
    format ??= state.design.format ?? 'image';
    if (!['layout', 'image'].includes(format)) throw new Error('시안 형식을 확인하세요.');
    run.designBusy = true;
    let settleDesign;
    run.designSettled = new Promise(resolve => { settleDesign = resolve; });
    state.design = { ...state.design, status: "generating", provider, format };
    const notes = [...state.design.feedback, redact(feedback.trim())].filter(Boolean).slice(-5);
    state.design.feedback = notes;
    try {
      if (format === 'layout') {
        state.design = { ...state.design, status:'ready', feedback:notes, revisionId:randomUUID(), artifactId:null, hash:null, path:null, previewText:layoutPreview(state.request, state.design.specification, notes) };
        await this.record(run, 'gpt', '이미지 API 없이 UI 구조안을 준비했습니다. UI 시안에서 확인하고 마음에 들면 ‘이대로 적용’이라고 입력해 주세요.');
        return state.design;
      }
      await this.record(run, "gpt", "UI 시안을 만드는 중입니다.");
      const direction = notes.length
        ? "Follow the latest user feedback over earlier visual direction. Keep all functional requirements.\nUser feedback:\n" + notes.join("\n").slice(-4300)
        : "Default visual direction, unless the request specifies a style: use a clear primary task, readable typography, intentional spacing and one confident accent. Choose a composition that fits this product and platform. Show meaningful states with legible Korean when appropriate. Use expressive shape or illustration only when it serves the task. Keep text contrast and touch targets accessible. Avoid generic dashboard cards, ornamental gradients and fake device frames.";
      const prompt = ("Create a product UI mockup based on this request and specification.\n" +
        state.request.slice(0, 1800) + "\n" + JSON.stringify(state.design.specification).slice(0, 4800) +
        "\n" + direction).slice(0, 12000);
      const result = await this.designGenerator(projectId, prompt, provider, run.controller.signal);
      run.controller.signal.throwIfAborted();
      state.design = { ...state.design, status: "ready", feedback: notes, artifactId: result.artifactId, path: result.path, hash: result.hash };
      await this.record(run, "gpt", "UI 시안을 한번 확인해 주시겠습니까? 마음에 들면 ‘이대로 적용’이라고 입력해 주세요.");
      return result;
    } catch (error) {
      if (!run.controller.signal.aborted) {
        state.design.status = "error";
        await this.record(run, "gpt", "시안 생성에 실패했습니다. UI 시안 탭에서 키를 연결하거나 다시 생성하세요.");
      }
      throw error;
    } finally {
      run.designBusy = false;
      settleDesign();
    }
  }
  async approveDesign(projectId, conversationId) {
    const run = this.runs.get(projectId);
    // A ready preview can reach the renderer while its completion record is
    // still being persisted. Honor that click after persistence, then recheck
    // the run/revision rather than rejecting a visibly ready design.
    if (run?.state.status === 'awaiting_design' && run.state.options.conversationId === conversationId &&
        run.state.design?.status === 'ready' && run.designBusy) await run.designSettled;
    if (run?.state.status !== "awaiting_design" ||
        run.state.options.conversationId !== conversationId ||
        run.state.design?.status !== "ready" || run.designBusy || !run.acceptDesign)
      throw new Error("현재 대화에서 검토할 시안이 준비될 때까지 기다려 주세요.");
    run.controller.signal.throwIfAborted();
    run.state.design.status = "approved";
    await this.record(run, "gpt", "승인한 UI 시안과 수정 요청을 반영해 구현을 시작합니다.");
    run.acceptDesign();
  }
  async snapshot(run) {
    run.controller.signal.throwIfAborted();
    await this.workspace.grant(run.state.projectId, run.state.grantId);
    const snapshot = await this.workspace.snapshot(run.state.projectId);
    if (snapshot.truncated)
      throw new Error(
        "프로젝트가 현재 검토 범위를 초과합니다. 제외 파일을 확인한 뒤 더 작은 작업 폴더로 나누세요.",
      );
    return snapshot;
  }
  async worker(run, task, issues = []) {
    const { state } = run;
    const snapshot = await this.snapshot(run);
    task.status = "working";
    if (state.testing?.result) state.testing.stale = true;
    task.startedAt = new Date().toISOString();
    if (task.kind === "test") {
      state.status = "testing";
      if (state.testing) state.testing.status = "writing";
    }
    await this.record(
      run,
      task.owner,
      `${task.title || task.id}: ${issues.length ? "지적된 문제를 수정합니다." : "구현을 시작합니다."}`,
      { taskId: task.id, activity: "dispatch" },
    );
    let designImage;
    if (task.kind === "ui" && state.design?.status === "approved" && state.design.hash) {
      const buffer = await this.workspace.read(state.projectId, state.design.path, { grantId: state.grantId, maxBytes: 16 * 1024 * 1024 });
      if (digest(buffer) !== state.design.hash) throw new Error("승인한 UI 시안 파일이 변경되었습니다.");
      designImage = buffer.toString("base64");
      if(state.visual?.status==='repairing'&&state.visual.evidence?.comparison){
        const comparison=state.visual.evidence.comparison,bytes=await this.workspace.read(state.projectId,comparison.path,{grantId:state.grantId,internal:true,maxBytes:16*1024*1024});
        if(digest(bytes)!==comparison.hash)throw new Error('시안 비교 캡처가 바뀌었습니다.');
        designImage=bytes.toString('base64');
      }
    }
    const report = await this.callAgent(run, task.owner, "build", {
      designImage,
      task:
        task.kind === "test"
          ? {
              ...task,
              instructions: `${task.instructions}\nHost test plan: ${JSON.stringify({ ...state.testing.plan, cases: state.testing.plan.cases.filter((row) => task.requirementIds.includes(row.requirementId)), assignedFiles: task.testFiles ?? state.testing.plan.files })}\nWrite meaningful assertions for every case. Use node:test, name each test starting with its case ID (e.g. T1). Only edit assignedFiles, not every file in the full test plan. Never modify application code or weaken requirements. Do not claim execution. No package installation.`,
            }
          : state.visual?.status==='repairing'&&task.kind==='ui' ? {...task,instructions:task.instructions+'\nVisual repair: attached LEFT panel is the approved reference, RIGHT is the previous implementation. Correct only the supplied UI differences. Preserve all behavior, tests and the reference.'} : task,
      issues,
      validation: state.validation ? { ...state.validation, stale: true } : null,
      previousTaskReports: state.tasks.filter(row=>row.status==='reported').map(row=>({id:row.id,owner:row.owner,kind:row.kind,summary:row.report?.summary})),
      spec: state.spec,
      design: state.design?.status === "approved" ? state.design : undefined,
      snapshot,
      options: state.options,
      signal: run.controller.signal,
    });
    run.controller.signal.throwIfAborted();
    if (
      !report ||
      typeof report.summary !== "string" ||
      !Array.isArray(report.files) ||
      report.files.length > 60
    )
      throw new Error("작업 결과의 파일 목록을 확인하지 못했습니다.");
    const seen = new Set();
    for (const file of report.files) {
      file.path = relativeFile(file.path).join("/");
      if(file.path===state.design?.path)throw new Error('승인한 시안은 구현 담당자가 변경할 수 없습니다.');
      if(state.visual?.status==='repairing'){
        const allowed=task.writePaths??task.report?.changed?.map(row=>row.path)??[];
        if(task.kind!=='ui'||!allowed.includes(file.path)||/\.(?:test|spec)\.[^.]+$|(?:^|\/)(?:tests?|__tests__|Function|package\.json|package-lock\.json)(?:\/|$)/i.test(file.path)||
          (state.ownership?.[file.path]&&state.ownership[file.path].owner!==task.owner))throw new Error('시안 보정은 원래 UI 구현 파일만 수정할 수 있습니다.');
      }
      if (task.writePaths && !task.writePaths.includes(file.path))
        throw new Error(`계획에 선언되지 않은 변경입니다: ${file.path}`);
      if (state.testFailure?.status === "repairing" &&
          (state.testing?.plan.files.includes(file.path) || /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$|(?:^|\/)package\.json$/i.test(file.path)))
        throw new Error(`실패 복구 중에는 원래 테스트와 실행 설정을 변경할 수 없습니다: ${file.path}`);
      if (
        task.kind === "test" &&
        !(task.testFiles ?? state.testing.plan.files).includes(file.path)
      )
        throw new Error(
          "테스트 담당자는 계획에 선언한 테스트 코드만 수정할 수 있습니다.",
        );
      if (
        seen.has(process.platform === "win32" ? file.path.toLowerCase() : file.path) ||
        typeof file.content !== "string" ||
        Buffer.byteLength(file.content) > 500000
      )
        throw new Error("작업 결과의 파일 경로나 크기가 올바르지 않습니다.");
      seen.add(process.platform === "win32" ? file.path.toLowerCase() : file.path);
    }
    const proposed = report.files.map((file) => {
      const line = secretFinding(file.content);
      if (line) throw new Error(`비밀값 탐지: ${file.path}:${line}`);
      const before = snapshot.files.find((entry) => entry.path === file.path);
      if (before && secretFinding(before.content)) throw new Error(`비밀값이 있는 원본 파일은 수동으로 정리하세요: ${file.path}`);
      return { ...file, baseHash: before?.hash ?? null, hash: digest(file.content) };
    }).filter((file) => file.hash !== file.baseHash);
    const risky = proposed.filter(({ path }) =>
      /(?:^|[/. _-])(?:auth|oauth|permissions?|schema|migrations?|contracts?|openapi|ipc|deploy)(?:[/. _-]|$)|(?:^|\/)package\.json$/i.test(path) ||
      (state.ownership?.[path] && state.ownership[path].taskId !== task.id),
    );
    if (state.options.crossReview && risky.length) {
      const peers = sortReviewAgents(teamFor(state.options)).filter((agent) => agent.id !== task.owner);
      const reviewer = peers.find((agent) => agent.roles.includes("review")) ?? peers[0];
      if (!reviewer) throw new Error("위험 변경을 검토할 다른 작업 패널이 필요합니다.");
      const staged = new Map(snapshot.files.map((file) => [file.path, file]));
      for (const file of proposed) staged.set(file.path, file);
      const review = validateReview(await this.callAgent(run, reviewer.id, "review", {
        snapshot: { ...snapshot, hash: digest(JSON.stringify([...staged.values()].map(({ path, hash }) => [path, hash]))), files: [...staged.values()] },
        options: state.options, signal: run.controller.signal,
        tasks: [task], spec: state.spec,
        validation: { summary: "파일 적용 전 교차 검토", riskyPaths: risky.map((file) => file.path) },
      }), [task]);
      await this.record(run, reviewer.id, review.summary, { taskId: task.id, activity: "cross-review", riskyPaths: risky.map((file) => file.path), approved: !review.issues.length });
      if (review.issues.length)
        throw Object.assign(new Error("교차 검토에서 적용을 보류했습니다. " + redact(review.issues.map((issue) => issue.description).join(" / "))), { code: "CROSS_REVIEW", issues: review.issues });
    }
    run.controller.signal.throwIfAborted();
    const checkpoint = await applyBatch(this.workspace, state.projectId, state.grantId,
      proposed, task.title || task.id, (task.readPaths ?? []).map((path) => ({
        path, baseHash: snapshot.files.find((file) => file.path === path)?.hash ?? null,
      })), state.id);
    const changed = proposed.map(({ path, hash }) => ({ path, hash }));
    state.ownership ??= {};
    for (const file of changed)
      state.ownership[file.path] = { owner: task.owner, taskId: task.id, hash: file.hash };
    for (const file of proposed) {
      await this.record(run, task.owner, `${file.path} 저장`, {
        taskId: task.id, path: file.path, checkpoint,
        preview: file.content.slice(0, 8000),
        previewTruncated: file.content.length > 8000,
      });
    }
    task.status = "reported";
    task.executedProvider = report.executedProvider ?? teamFor(state.options).find((agent) => agent.id === task.owner)?.provider;
    if(report.executedModel) task.executedModel=report.executedModel;
    if (task.kind === "test" && state.testing) state.testing.status = "ready";
    task.report = {
      summary: report.summary,
      changed,
      at: new Date().toISOString(),
    };
    await this.record(
      run,
      task.owner,
      `${task.title || task.id}: ${controllerName(state)}에 완료 보고를 전달했습니다.`,
      { taskId: task.id, summary: report.summary, activity: "report" },
    );
  }
  async buildTasks(run, taskIds, issues = []) {
    const selected = new Set(taskIds);
    const running = new Map();
    const owners = new Set();
    for (const task of run.state.tasks.filter((task) => selected.has(task.id)))
      task.status = "pending";
    const launch = (task) => {
      owners.add(task.owner);
      const taskIssues = issues.filter((issue) => issue.taskId === task.id);
      const promise = this.worker(run, task, taskIssues).catch(async (error) => {
        const changedBy = run.state.ownership?.[error.path];
        const internalConflict = error.code === "WORKSPACE_CONFLICT" &&
          changedBy && changedBy.taskId !== task.id && changedBy.hash === error.actualHash;
        const reviewRepair = error.code === "CROSS_REVIEW" && run.state.options.maxRepairRounds > 0;
        if (!internalConflict && !reviewRepair) throw error;
        await this.record(run, "system", `${task.title || task.id}: 최신 파일 또는 검토 의견을 반영해 한 번 다시 시도합니다.`);
        return this.worker(run, task, reviewRepair ? [...taskIssues, ...error.issues] : taskIssues);
      }).then(
        () => ({ id: task.id, owner: task.owner }),
        (error) => ({ id: task.id, owner: task.owner, error }),
      );
      running.set(task.id, promise);
    };
    while (true) {
      run.controller.signal.throwIfAborted();
      const pending = run.state.tasks.filter(
        (task) => selected.has(task.id) && task.status === "pending",
      );
      for (const task of pending) {
        if (
          !owners.has(task.owner) &&
          !run.state.tasks.some((other) => running.has(other.id) &&
            ((task.writePaths ?? []).some((path) => [...(other.writePaths ?? []), ...(other.readPaths ?? [])].includes(path)) ||
             (task.readPaths ?? []).some((path) => (other.writePaths ?? []).includes(path)))) &&
          task.dependsOn.every(
            (id) =>
              run.state.tasks.find((candidate) => candidate.id === id)
                ?.status === "reported",
          )
        )
          launch(task);
      }
      if (!running.size) {
        if (pending.length)
          throw new Error("작업 의존성 때문에 진행할 수 없습니다.");
        break;
      }
      const done = await Promise.race(running.values());
      running.delete(done.id);
      owners.delete(done.owner);
      if (done.error) {
        const cancelled = run.controller.signal.aborted;
        run.controller.abort();
        await Promise.all(running.values());
        // A failed worker is an error, not an intentional user cancellation.
        if (!cancelled) run.failure = done.error;
        throw done.error;
      }
    }
  }
  async sequentialReview(run, frozen) {
    const { state } = run;
    const participants = reviewOrder(state.options);
    state.reviews = [];
    state.reviewChain = participants.map(agent=>({actor:agent.id,provider:agent.provider,
      roles:agent.roles.filter(role=>['control','debug','review'].includes(role)),status:'pending',round:state.round,snapshotHash:frozen.hash}));
    state.status = 'reviewing';
    await this.record(run,'system','순차 검토: '+participants.map(agent=>`${PROVIDER_NAMES[agent.provider]}${agent.id==='gpt'?' (컨트롤 타워 · 마지막)':''}`).join(' → '));
    if (!state.validation?.configured || state.validation.requiresConsent || state.validation.stale) {
      await this.record(run,'system','실행 검증 결과를 확인한 뒤 순차 검토를 시작합니다.');
      return [];
    }
    for (const step of state.reviewChain) {
      run.controller.signal.throwIfAborted();
      step.status = 'working';
      state.status = step.actor === 'gpt' ? 'final_review' : 'reviewing';
      await this.record(run,step.actor,`${step.actor==='gpt'?'컨트롤 타워 최종':'디버깅·코드'} 검토를 시작합니다. 이전 결과와 같은 파일 버전을 확인합니다.`,{activity:'sequential-review',reviewActor:step.actor});
      const result = validateReview(await this.callAgent(run,step.actor,'review',{
        snapshot:frozen,tasks:state.tasks,ownership:state.ownership,
        validation:{...state.validation,mutation:state.mutation},spec:state.spec,
        priorReviews:structuredClone(state.reviews),reviewSequence:participants.map(agent=>agent.id),reviewScope:step.roles,
        signal:run.controller.signal,options:state.options,
      }),state.tasks,state.ownership);
      if ((await this.snapshot(run)).hash !== frozen.hash) throw new Error('순차 검토 중 파일이 변경되었습니다. 검토를 중단하고 다시 검증하세요.');
      const review = {...result,actor:step.actor,snapshotHash:frozen.hash,round:state.round};
      state.reviews.push(review);
      step.provider = result.executedProvider ?? step.provider;
      step.summary = result.summary;
      step.issueCount = result.issues.length;
      step.status = result.issues.length ? 'changes' : !state.validation.passed || (state.options.mutation && !state.mutation?.passed) ? 'blocked' : 'passed';
      await this.record(run,step.actor,`${step.status==='passed'?'OK':step.status==='changes'?'수정 필요':'실행 검증 확인 필요'} · ${result.summary}`,
        {activity:'sequential-review',reviewActor:step.actor,issues:result.issues,snapshotHash:frozen.hash,provider:step.provider});
      if (step.status !== 'passed') break;
    }
    return state.reviews;
  }
  async execute(run) {
    const { state } = run;
    const snapshot = await this.snapshot(run);
    const enabled = state.options.funEnabled !== false;
    const skill = enabled ? await readFile(
      new URL("../skills/fun.md", import.meta.url),
      "utf8",
    ) : null;
    state.governance = {
      enabled,
      skill: enabled ? "fun" : null,
      sha256: enabled ? skillHash(skill) : null,
      contractVersion: state.options.funContract ? 1 : 0,
    };
    let plan;
    for (let attempt = 0; attempt < 2; attempt++) {
      const proposed = await this.callAgent(run, "gpt", "plan", {
        request: state.request,
        snapshot,
        options: state.options,
        signal: run.controller.signal,
      });
      try {
        plan = validatePlan(orderDebugTasks(
          state.options.funContract
            ? compileFunPlan(proposed, state.options)
            : proposed,
          state.options), state.options);
        break;
      } catch (error) {
        if (attempt) throw error;
        await this.record(
          run,
          "gpt",
          `명세 누락을 감지해 보완을 요청합니다: ${error.message}`,
        );
        state.options.planCorrection = error.message;
      }
    }
    delete state.options.planCorrection;
    if (plan.questions?.length) {
      state.status = "needs_input";
      state.questions = clarificationQuestions(plan.questions);
      state.questionBatchId = randomUUID();
      await this.record(run, "gpt", "누락된 요구사항에 대한 답이 필요합니다.", {
        questions: state.questions,
      });
      return;
    }
    state.spec = plan.spec;
    if (
      state.options.suggestRepositoryName &&
      typeof plan.repositoryName === "string" &&
      /^[a-z0-9][a-z0-9-]{0,44}$/.test(plan.repositoryName)
    )
      state.repositoryName = plan.repositoryName;
    state.requirements = plan.requirements ?? [];
    state.decisions = plan.decisions ?? [];
    state.reviewItems = plan.reviewItems ?? [];
    if (plan.testPlan) {
      state.testing = { status: "planned", plan: plan.testPlan, result: null };
      state.options.testPlan = plan.testPlan;
      await this.workspace.write(
        state.projectId,
        `.control-tower/runs/${state.id}/test-plan.md`,
        testPlanMarkdown(plan.testPlan),
        { internal: true, grantId: state.grantId, newOnly: true },
      );
    }
    state.tasks = plan.tasks.map((task) => ({ ...task, status: "pending" }));
    await this.workspace.write(
      state.projectId,
      enabled ? `Function/${state.id}_fun.md` : `.control-tower/runs/${state.id}/spec.md`,
      state.spec,
      { newOnly: true, grantId: state.grantId, internal: !enabled },
    );
    if (state.options.designApproval && (this.designGenerator || state.options.designMode === 'layout') && state.tasks.some((task) => task.kind === "ui")) {
      state.status = "awaiting_design";
      state.design = { status: "pending", format:state.options.designMode ?? 'image', feedback: [], specification: plan.design ?? plan.spec.slice(0, 4800) };
      const approval = new Promise((resolve, reject) => {
        const signal = run.controller.signal;
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        run.acceptDesign = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
      });
      void approval.catch(() => {});
      void this.reviseDesign(state.projectId, "", state.options.imageProvider ?? "gpt", state.options.conversationId).catch(() => {});
      await approval;
      run.controller.signal.throwIfAborted();
    }
    state.status = "building";
    await this.record(
      run,
      "gpt",
      "기능 명세를 저장하고 담당 AI에 작업을 전달합니다.",
    );
    await this.buildTasks(
      run,
      state.tasks.map((task) => task.id),
    );
    return this.verifyAndRepair(run);
  }
  async reviewVisual(run,frozen){
    const {state}=run,previous=state.visual;
    if(state.options.visualReview===false)return state.visual={status:'disabled',summary:'사용자가 시안 일치 검토를 끈 작업입니다.'};
    if(state.design?.status!=='approved'||!state.design.hash)return state.visual={status:'not_applicable',summary:'승인한 이미지 시안이 없어 이미지 일치 검토 대상이 아닙니다.'};
    const tasks=state.tasks.filter(task=>task.kind==='ui');
    if(!tasks.length)return state.visual={status:'not_applicable',summary:'UI 구현 작업이 없습니다.'};
    state.visual={status:'capturing',summary:'구현 화면을 같은 크기로 캡처합니다.',round:state.round};
    await this.record(run,tasks[0].owner,state.visual.summary,{activity:'visual-review'});
    try{
      if(!this.visualCapture)throw new Error('시안 비교 캡처 도구가 준비되지 않았습니다.');
      const evidence=await this.visualCapture.capture({projectId:state.projectId,grantId:state.grantId,runId:state.id,round:state.round,referencePath:state.design.path,referenceHash:state.design.hash,sourceHash:frozen.hash,options:state.options,signal:run.controller.signal});
      if(evidence.sourceHash!==frozen.hash||evidence.referenceHash!==state.design.hash)throw new Error('현재 소스와 같은 시안 비교 캡처가 아닙니다.');
      state.visual={...state.visual,evidence,status:'reviewing',summary:'UI 담당 AI가 시안과 구현 화면을 항목별로 비교합니다.'};
      await this.record(run,tasks[0].owner,state.visual.summary,{activity:'visual-review'});
      if(!run.forceVisual&&previous?.status==='matched'&&previous.evidence?.actual.hash===evidence.actual.hash&&previous.evidence.referenceHash===evidence.referenceHash){
        state.visual={...previous,evidence,reused:true,summary:'동일한 시안·구현 이미지의 이전 AI 판정을 재사용했습니다.'};
      }else{
        const bytes=await this.workspace.read(state.projectId,evidence.comparison.path,{grantId:state.grantId,internal:true,maxBytes:16*1024*1024});
        if(digest(bytes)!==evidence.comparison.hash)throw new Error('비교 이미지가 바뀌었습니다.');
        const result=await this.callAgent(run,tasks[0].owner,'review',{snapshot:frozen,tasks,task:tasks[0],options:state.options,signal:run.controller.signal,spec:state.spec,
          designImage:bytes.toString('base64'),visualComparison:{viewport:evidence.viewport,panels:'LEFT approved reference; RIGHT actual render',designSpecification:state.design.specification,metrics:evidence.metrics}});
        const verdict=validateVisualReview(result,tasks,state.design.path);
        state.visual={...state.visual,...verdict,status:verdict.verdict==='match'?'matched':verdict.verdict==='mismatch'?'mismatch':'blocked',provider:result.executedProvider,model:result.executedModel,actor:tasks[0].owner,reused:false};
      }
      run.forceVisual=false;
      if((await this.snapshot(run)).hash!==frozen.hash||!await this.visualCapture.stable(state.projectId,state.grantId,evidence))throw new Error('시안 검토 중 소스·리소스가 바뀌었습니다.');
      await this.record(run,tasks[0].owner,state.visual.summary,{activity:'visual-review',visualStatus:state.visual.status});
    }catch(error){
      run.controller.signal.throwIfAborted();
      state.visual={...state.visual,status:'blocked',summary:redact(error.message),requiresPreviewConsent:error.requiresPreviewConsent===true};
      await this.record(run,'system','시안 일치 확인 필요 · '+state.visual.summary,{activity:'visual-review'});
    }
    return state.visual;
  }
  async retryVisual(projectId,runId,options){
    if(this.isActive(projectId)||this.starting.has(projectId))throw new Error('현재 작업이 끝난 뒤 다시 비교하세요.');
    this.starting.add(projectId);
    try{
    const state=await this.current(projectId,runId);
    if(!state?.visual||state.design?.status!=='approved')throw new Error('비교할 승인 시안이 없습니다.');
    if((await this.workspace.snapshot(projectId)).hash!==state.snapshotHash)throw new Error('소스가 변경됐습니다. 컨트롤 타워에서 새 작업으로 재검토하세요.');
    state.options.allowExecution=options.allowExecution===true;state.options.visualReview=true;
    if(options.executionBackend)state.options.executionBackend=options.executionBackend;
    if(options.dockerImage)state.options.dockerImage=options.dockerImage;
    const run={state,controller:new AbortController(),queue:Promise.resolve(),forceVisual:true};this.runs.set(projectId,run);this.launch(run,true);return structuredClone(state);
    }finally{this.starting.delete(projectId);}
  }
  async verifyAndRepair(run){
    const {state}=run;
    while (true) {
      state.status = "validating";
      state.reviewChain = [];
      state.reviews = [];
      if (state.testing)
        state.testing.status = state.options.allowExecution
          ? "running"
          : "permission";
      await this.record(run, "system", "프로젝트 검증을 실행합니다.");
      const beforeValidation = await this.snapshot(run);
      state.validation = await this.validate({
        projectId: state.projectId,
        grantId: state.grantId,
        options: state.options,
        signal: run.controller.signal,
        onOutput: (event) =>
          this.notify({
            type: "agent-progress",
            projectId: state.projectId,
            conversationId: state.options.conversationId,
            agentId:
              teamFor(state.options).find((agent) =>
                agent.roles.includes("test"),
              )?.id ?? "gpt",
            ...event,
          }),
      });
      if (state.options.mutation) {
        const stableBaseline = beforeValidation.hash === (await this.snapshot(run)).hash;
        if (state.validation.passed && stableBaseline) {
          state.mutation = { passed: false, status: "running", summary: "핵심 로직의 변이를 실행하는 중입니다." };
          await this.record(run, "system", state.mutation.summary);
        }
        state.mutation = state.validation.passed && stableBaseline
          ? await runMutation(this.workspace, {
              projectId: state.projectId,
              grantId: state.grantId,
              options: state.options,
              signal: run.controller.signal,
              onOutput: (event) => this.notify({ type: "agent-progress", projectId: state.projectId, conversationId: state.options.conversationId, agentId: "gpt", ...event }),
            }, this.validate)
          : { passed: false, status: "blocked", summary: "기본 테스트 통과 후 변이를 실행합니다. " + state.validation.summary };
        if (state.expectedMutationScope && state.mutation.scopeHash &&
            state.mutation.scopeHash !== state.expectedMutationScope)
          state.mutation = { ...state.mutation, passed: false, status: "blocked", summary: "테스트 보강 전후의 변이 범위가 달라 같은 변이를 검증할 수 없습니다." };
      }
      const frozen = await this.snapshot(run);
      state.snapshotHash = frozen.hash;
      if (beforeValidation.hash !== frozen.hash)
        state.validation = {
          ...state.validation,
          passed: false,
          stale: true,
          summary:
            "검증 중 소스가 변경되어 검증 결과를 현재 파일에 적용할 수 없습니다.",
        };
      if (state.mutation) {
        if (state.validation.stale)
          state.mutation = { ...state.mutation, passed: false, status: "blocked", summary: "검증 중 소스가 변경되었습니다." };
        await this.record(run, "system", "뮤테이션 테스트 · " + state.mutation.summary);
      }
      await this.testingResult(run);
      state.status = "reviewing";
      await this.record(
        run,
        "gpt",
        "변경 파일과 검증 결과를 읽기 전용으로 재검토합니다.",
      );
      state.testFailure = testFailure(state.validation, state.ownership);
      if (state.testFailure?.status === "intervention") {
        state.status = "awaiting_validation";
        await this.record(run, "system", state.testFailure.reason);
        return;
      }
      if(state.validation.passed&&!state.validation.stale){
        const visual=await this.reviewVisual(run,frozen);
        if(visual.status==='blocked'){
          state.status='awaiting_validation';await this.record(run,'system','기능 결과와 별도로 시안 일치 확인이 필요합니다.');return;
        }
        if(visual.status==='mismatch'){
          if(state.round>=state.options.maxRepairRounds){state.status='needs_attention';await this.record(run,'system','시안 보정 횟수 한도에 도달했습니다. 차이 항목을 직접 확인하세요.');return;}
          state.round++;state.status='repairing';state.visual.status='repairing';
          for(const issue of visual.issues)await this.record(run,issue.owner,'시안 보정 요청: '+issue.description,{activity:'visual-repair',taskId:issue.taskId});
          await this.buildTasks(run,[...new Set(visual.issues.map(issue=>issue.taskId))],visual.issues);continue;
        }
      }else state.visual={status:'waiting',summary:'기능 실행 검증을 통과한 뒤 시안을 비교합니다.'};
      const reviews = await this.sequentialReview(run, frozen);
      run.controller.signal.throwIfAborted();
      const after = await this.snapshot(run);
      if (after.hash !== frozen.hash)
        throw new Error(
          "검토 중 파일이 변경되었습니다. 현재 검토를 완료로 인정할 수 없습니다.",
        );
      state.reviews = reviews;
      const issues = reviews.flatMap((review) => review.issues).filter((issue) =>
        issue.mutationGap !== true || (
          state.mutation?.status === "findings" &&
          state.tasks.some((task) => task.id === issue.taskId && task.kind === "test")
        ),
      );
      if (state.validation.requiresConsent) issues.length = 0;
      if (state.testFailure) {
        const failure = state.testFailure;
        const issueCount = issues.length;
        for (let index = issues.length - 1; index >= 0; index--)
          if (state.tasks.some((task) => task.id === issues[index].taskId && task.kind === "test")) issues.splice(index, 1);
        const affected = state.tasks.filter((task) => task.kind !== "test" && failure.owners.includes(task.id));
        const implementation = state.tasks.filter((task) => task.kind === "feature" || task.kind === "ui");
        const target = affected.length === 1 ? affected[0] : !affected.length && implementation.length === 1 ? implementation[0] : null;
        const repeated = failure.signature === state.lastTestFailureSignature;
        const testOnly = issueCount > 0 && !issues.length;
        if (!repeated && !testOnly && !issues.length && target)
          issues.push({ taskId: target.id, owner: target.owner,
            description: "원래 테스트와 완료 기준을 유지하며 실패 원인을 수정하세요. " + [...failure.names, ...failure.stack].join("\n") });
        failure.owners = [...new Set(issues.map((issue) => issue.owner))];
        failure.reason = repeated ? "같은 테스트 실패가 반복됐습니다. 로그를 확인하고 수정 방향을 정해 주세요."
          : testOnly ? "검토에서 테스트 자체의 문제가 발견됐습니다. 원래 테스트를 유지했으니 기대값과 검증 기준을 확인해 주세요."
          : !issues.length ? "실패 원인을 담당 작업에 연결하지 못했습니다. 로그를 확인해 주세요."
          : state.round >= state.options.maxRepairRounds ? "자동 수정 한도에 도달했습니다. 남은 실패를 확인해 주세요."
          : "담당 AI가 실패 원인을 수정한 뒤 같은 검증을 다시 실행합니다.";
        if (repeated || !issues.length || state.round >= state.options.maxRepairRounds) {
          failure.status = "intervention";
          state.status = "needs_attention";
          await this.record(run, "system", failure.reason);
          return;
        }
        failure.status = "repairing";
        state.lastTestFailureSignature = failure.signature;
        for (const issue of issues)
          issue.description += "\n실패 증거: " + [...failure.names, ...failure.stack].join("\n");
      } else {
        delete state.lastTestFailureSignature;
      }
      if (!issues.length) {
        const finalStatus =
          state.validation.configured && state.validation.passed &&
          state.reviewChain?.length && state.reviewChain.every(step=>step.status==='passed') &&
          (!state.options.mutation || state.mutation?.passed)
            ? "completed"
            : "awaiting_validation";
        if(finalStatus==='completed'&&state.visual?.status==='matched'&&!await this.visualCapture.stable(state.projectId,state.grantId,state.visual.evidence))throw new Error('최종 시안 검토 이후 리소스가 바뀌었습니다.');
        if (finalStatus === "completed") await markVerified(this.workspace, state.projectId, state.grantId, frozen);
        state.status = finalStatus;
        await this.record(
          run,
          "gpt",
          state.status === "completed"
            ? "검증과 최종 검토를 통과했습니다."
            : "순차 검토가 아직 완료되지 않았습니다. 기본 테스트 또는 선택한 뮤테이션 테스트를 확인하세요.",
        );
        return;
      }
      if (state.round >= state.options.maxRepairRounds) {
        state.status = "needs_attention";
        await this.record(
          run,
          "gpt",
          "설정한 자동 수정 한도에 도달했습니다. 남은 문제를 확인하세요.",
          { issues },
        );
        return;
      }
      state.round++;
      state.status = "repairing";
      const selected = new Set(issues.map((issue) => issue.taskId));
      // Reconnect dependent UI/integration tasks whenever their feature changed.
      // Existing tests are rerun by validation, not regenerated by inference.
      // A test task is rebuilt only when a reviewer explicitly assigns it a gap.
      let grew = true;
      while (grew) {
        grew = false;
        for (const task of state.tasks)
          if (
            !selected.has(task.id) &&
            task.kind !== "test" &&
            task.dependsOn.some((id) => selected.has(id))
          ) {
            selected.add(task.id);
            grew = true;
          }
      }
      for (const issue of issues)
        await this.record(
          run,
          "gpt",
          `${state.options.team ? agentLabel(teamFor(state.options).find((agent) => agent.id === issue.owner)) : state.options.roles ? PROVIDER_NAMES[state.options.roles[issue.owner]] : issue.owner.toUpperCase()}에 수정 요청: ${issue.description}`,
          { taskId: issue.taskId },
        );
      state.expectedMutationScope = [...selected].every(
        (id) => state.tasks.some((task) => task.id === id && task.kind === "test"),
      ) ? (state.expectedMutationScope ?? state.mutation?.scopeHash) : null;
      await this.buildTasks(run, [...selected], issues);
    }
  }
  async testingResult(run) {
    const { state } = run;
    if (!state.testing) return;
    state.testing.stale = state.validation.stale === true;
    state.testing.status = state.validation.requiresConsent
      ? "permission"
      : state.validation.passed
        ? "passed"
        : "failed";
    state.testing.result = state.validation;
    const report = [
      testPlanMarkdown(state.testing.plan),
      "\n# 실제 실행 결과",
      `상태: ${state.testing.status}`,
      `명령: ${state.validation.command ?? "미실행"}`,
      `종료 코드: ${state.validation.exitCode ?? "없음"}`,
      `요약: ${state.validation.summary}`,
      ...(state.validation.cases ?? []).map(
        (row) => `- ${row.id}: ${row.status} · ${row.title}`,
      ),
      "\n```text",
      state.validation.output ?? "실행 출력 없음",
      "```",
    ].join("\n");
    await this.workspace.write(
      state.projectId,
      `.control-tower/runs/${state.id}/test-report.md`,
      report,
      { internal: true, grantId: state.grantId },
    );
  }
  async revalidate(projectId, runId, options) {
    if (this.isActive(projectId))
      throw new Error("진행 중인 작업이 끝난 후 테스트를 다시 실행하세요.");
    this.starting.add(projectId);
    try {
      const state = await this.current(projectId, runId);
      if (state?.options.mutation)
        throw new Error("뮤테이션 테스트를 포함한 새 작업으로 전체 검증을 다시 실행하세요.");
      if (!state || !state.testing)
        throw new Error("이 대화에는 테스트 계획이 없습니다.");
      const before = await this.workspace.snapshot(projectId);
      if (before.hash !== state.snapshotHash)
        throw new Error(
          "검토 이후 소스가 변경되었습니다. 컨트롤 타워에 재검토를 요청하세요.",
        );
      const run = {
        state,
        controller: new AbortController(),
        queue: Promise.resolve(),
      };
      this.runs.set(projectId, run);
      state.options.allowExecution = options.allowExecution === true;
      // Revalidation must honor the current execution boundary, including old
      // sessions created before Docker became the default. Other work settings
      // remain frozen for reproducibility.
      if (options.executionBackend) state.options.executionBackend = options.executionBackend;
      if (options.dockerImage) state.options.dockerImage = options.dockerImage;
      state.status = "validating";
      state.testing.status = state.options.allowExecution
        ? "running"
        : "permission";
      state.reviewChain = [];
      state.reviews = [];
      await this.record(run, "system", "저장된 테스트를 다시 실행합니다.");
      run.promise = (async () => {
        state.validation = await this.validate({
          projectId,
          grantId: state.grantId,
          options: state.options,
          signal: run.controller.signal,
          onOutput: (event) =>
            this.notify({
              type: "agent-progress",
              projectId,
              conversationId: state.options.conversationId,
              agentId: "gpt",
              ...event,
            }),
        });
        const after = await this.workspace.snapshot(projectId);
        if (before.hash !== after.hash) {
          if(state.visual)state.visual={...state.visual,status:'stale',summary:'검증 중 소스가 변경돼 이전 시안 판정이 무효화됐습니다.'};
          state.validation = {
            ...state.validation,
            passed: false,
            stale: true,
            summary: "검증 중 소스가 변경되었습니다.",
          };
        }
        state.testFailure = testFailure(state.validation, state.ownership);
        if (state.testFailure?.status === "diagnosed") {
          state.testFailure.status = "intervention";
          state.testFailure.reason = "재실행에서도 테스트가 실패했습니다. 로그를 확인한 뒤 새 작업으로 수정을 요청하세요.";
        }
        await this.testingResult(run);
        let visualOK=true;
        if(state.validation.passed&&!state.validation.stale){const visual=await this.reviewVisual(run,after);visualOK=['matched','not_applicable','disabled'].includes(visual.status);if(visualOK)await this.sequentialReview(run,after);}
        const reviewed = state.reviewChain?.length && state.reviewChain.every(step=>step.status==='passed') &&
          state.reviews?.length === state.reviewChain.length && state.reviews.every(review=>!review.issues.length);
        const finalStatus = state.validation.passed && !state.validation.stale && reviewed && visualOK ? "completed" : "awaiting_validation";
        if(finalStatus==='completed'&&(await this.workspace.snapshot(projectId)).hash!==after.hash)throw new Error('최종 검토 중 소스가 바뀌었습니다. 새 작업으로 다시 확인하세요.');
        if(finalStatus==='completed'&&state.visual?.status==='matched'&&!await this.visualCapture.stable(projectId,state.grantId,state.visual.evidence))throw new Error('시안 검토 이후 리소스가 바뀌었습니다.');
        if (finalStatus === "completed") await markVerified(this.workspace, projectId, state.grantId, after);
        state.status = finalStatus;
        await this.record(run, "system", state.validation.summary);
      })().catch(async (error) => {
        state.status = run.controller.signal.aborted
          ? "cancelled"
          : "needs_attention";
        state.testing.status = run.controller.signal.aborted
          ? "cancelled"
          : "failed";
        state.testing.stale = true;
        await this.record(run, "system", error.message);
      });
      return structuredClone(state);
    } finally {
      this.starting.delete(projectId);
    }
  }
  async invalidateAfterRestore(projectId) {
    const state = await this.current(projectId);
    if (!state) return;
    state.status = "awaiting_validation";
    state.snapshotHash = null;
    if(state.visual)state.visual={...state.visual,status:'stale',summary:'파일 복원으로 이전 시안 판정이 무효화됐습니다.'};
    state.validation = { configured: false, passed: false, stale: true, summary: "파일을 복원했습니다. 새 작업에서 다시 검증하세요." };
    if (state.testing) state.testing.stale = true;
    const run = { state, queue: Promise.resolve() };
    this.runs.set(projectId, run);
    await this.record(run, "system", state.validation.summary);
  }
  async current(projectId, runId = null) {
    const active = this.runs.get(projectId);
    if (active && (!runId || active.state.id === runId)) {
      try {
        const grant = await this.workspace.grant(projectId);
        if (grant.root !== active.state.root) return null;
      } catch {
        return null;
      }
      return structuredClone(active.state);
    }
    try {
      const pointer = runId
        ? { id: runId }
        : JSON.parse(
            (
              await this.workspace.read(
                projectId,
                ".control-tower/latest-run.json",
                { internal: true },
              )
            ).toString(),
          );
      if (!/^[0-9a-f-]{36}$/.test(pointer.id))
        throw new Error("잘못된 작업 기록");
      const state = JSON.parse(
        (
          await this.workspace.read(
            projectId,
            `.control-tower/runs/${pointer.id}/state.json`,
            { internal: true, maxBytes: 20000000 },
          )
        ).toString(),
      );
      if (ACTIVE.has(state.status)) state.status = "interrupted";
      return state;
    } catch (error) {
      if (error.code === "ENOENT" || !(await this.hasGrant(projectId)))
        return null;
      throw error;
    }
  }
  async hasGrant(projectId) {
    try {
      await this.workspace.grant(projectId);
      return true;
    } catch {
      return false;
    }
  }
  stop(projectId) {
    const run = this.runs.get(projectId);
    if (run && this.isActive(projectId)) run.controller?.abort();
  }
  async stopAndWait(projectId) {
    this.stop(projectId);
    await this.runs.get(projectId)?.promise;
  }
  stopAll() {
    for (const projectId of this.runs.keys()) this.stop(projectId);
  }
}
