import {
  defaultTeam,
  validateTeam,
  teamFor,
  agentOptions,
  SLOT_IDS,
  exclusiveTeam,
} from "./team.js";
import { isQuotaExhausted,isAuthenticationFailure } from "./provider-errors.js";
import { remainingQuota, replacementCandidates } from "./quota-routing.js";
import { rememberTeam } from './team-memory.js';
export const DEFAULT_ROLES = Object.freeze({
  gpt: "gpt",
  grok: "grok",
  claude: "claude",
});
export const PROVIDER_NAMES = Object.freeze({
  gpt: "GPT",
  claude: "Claude",
  grok: "Grok · Cursor",
  gemini: "Gemini",
});
export const ROLE_NAMES = Object.freeze({
  gpt: "컨트롤 타워",
  grok: "기능 구현",
  claude: "UI 구현·연결",
});
export function validateRoles(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(DEFAULT_ROLES).some(
      (role) => !Object.hasOwn(PROVIDER_NAMES, value[role]),
    )
  )
    throw new Error("세 역할에 사용할 AI를 각각 선택하세요.");
  return Object.fromEntries(
    Object.keys(DEFAULT_ROLES).map((role) => [role, value[role]]),
  );
}
export class RoleAssignments {
  constructor(projects) {
    this.projects = projects;
  }
  async get(id) {
    const project = this.projects.find(await this.projects.list(), id);
    return validateRoles(project.roles ?? DEFAULT_ROLES);
  }
  async set(id, value) {
    const roles = validateRoles(value);
    await this.projects.mutate((data) => {
      const project = this.projects.find(data, id);
      rememberTeam(data, project, defaultTeam(roles));
    });
    return roles;
  }
  async getTeam(id) {
    const project = this.projects.find(await this.projects.list(), id);
    let team = project.team ?? defaultTeam(project.roles ?? DEFAULT_ROLES);
    const legacy = [["control", "debug"], ["feature"], ["ui"]];
    if (
      team.length === 3 &&
      team.every(
        (row, index) =>
          JSON.stringify(row.roles) === JSON.stringify(legacy[index]),
      )
    )
      team = team.map((row, index) => ({
        ...row,
        roles: defaultTeam()[index].roles,
      }));
    return exclusiveTeam(team);
  }
  async setTeam(id, value) {
    const team = validateTeam(value, { exclusive: true });
    await this.projects.mutate((data) => {
      const project = this.projects.find(data, id);
      rememberTeam(data, project, team);
    });
    return team;
  }
}
// Keep existing task owner IDs stable for persisted runs; route by frozen role assignment.
export function roleProviders(
  providers,
  { getUsage = () => null, confirmCursorUI = async () => false,onAuthenticationFailure=()=>{},assertAuthentication=()=>{} } = {},
) {
  const routeKey = (agent) => agent.provider + ":" + (agent.modelId ?? "");
  const usageSnapshot = async (options) => {
    try {
      return await getUsage(options);
    } catch {
      return null;
    }
  };
  async function choose(
    role,
    action,
    context,
    attempted,
    reason,
    proactive = false,
  ) {
    const options = context.options,
      snapshot = await usageSnapshot(options);
    for (const next of replacementCandidates(
      options,
      role,
      action,
      context.task,
      snapshot,
      attempted,
      proactive,
    )) {
      context.signal?.throwIfAborted();
      const route = {
        provider: next.provider,
        ...(next.modelId ? { modelId: next.modelId } : {}),
      };
      const routed = {
        ...options,
        runtimeRoutes: { ...options.runtimeRoutes, [role]: route },
      };
      try {
        if (
          !(await providers[next.provider]?.ready(agentOptions(routed, role)))
        )
          continue;
      } catch (error) {
        if (isQuotaExhausted(error)) {
          options.exhaustedProviders ??= [];
          if (!options.exhaustedProviders.includes(next.provider))
            options.exhaustedProviders.push(next.provider);
        }
        continue;
      }
      context.signal?.throwIfAborted();
      const previous = teamFor(options).find((row) => row.id === role);
      await options.onProviderSwitch?.({
        actor: role,
        from: previous.provider,
        ...route,
        reason,
        action,
      });
      options.runtimeRoutes ??= {};
      options.runtimeRoutes[role] = route;
      return true;
    }
    return false;
  }
  async function authorize(role, action, context, agent) {
    if (
      action !== "build" ||
      context.task?.kind !== "ui" ||
      agent.provider !== "grok"
    )
      return;
    const key = role + ":grok";
    if (context.options.cursorUiApproved?.includes(key)) return;
    const approved = await confirmCursorUI({
      actor: role,
      taskId: context.task.id,
      title: context.task.title,
      signal: context.signal,
    });
    context.signal?.throwIfAborted();
    if (!approved)
      throw new Error(
        "Cursor의 UI 구현·연결을 승인하지 않아 작업을 멈췄습니다. AI 역할 설정에서 다른 AI를 선택하세요.",
      );
    context.options.cursorUiApproved ??= [];
    context.options.cursorUiApproved.push(key);
    await context.options.onCursorUiApproved?.(key);
  }
  async function invoke(role, action, context) {
    const options = context.options,
      configured = validateTeam(
        options.team ?? defaultTeam(options.roles),
      ).find((row) => row.id === role);
    if (!configured) throw new Error("현재 팀에 없는 AI 패널입니다.");
    options.team ??= defaultTeam(options.roles);
    const attempted = new Set();
    let agent = teamFor(options).find((row) => row.id === role);
    if (options.autoFallback === true) {
      const quota = remainingQuota(
        await usageSnapshot(options),
        agent.provider,
        options,
      );
      if (options.exhaustedProviders?.includes(agent.provider) || quota === 0) {
        options.exhaustedProviders ??= [];
        if (!options.exhaustedProviders.includes(agent.provider))
          options.exhaustedProviders.push(agent.provider);
        attempted.add(routeKey(agent));
        if (
          !(await choose(role, action, context, attempted, "quota_exhausted"))
        )
          throw new Error(
            "현재 연결된 AI의 사용 한도를 확인하세요. 이어받을 수 있는 AI가 없습니다.",
          );
      } else if (quota !== null && quota <= 5) {
        attempted.add(routeKey(agent));
        await choose(role, action, context, attempted, "low_quota", true);
      }
    }
    const maximum = options.autoFallback === true ? 5 : 2;
    for (let attempt = 0; attempt < maximum; attempt++) {
      context.signal?.throwIfAborted();
      agent = teamFor(options).find((row) => row.id === role);
      attempted.add(routeKey(agent));
      await authorize(role, action, context, agent);
      await assertAuthentication(agent.provider,options);
      await options.onProviderAttempt?.({
        actor: role,
        provider: agent.provider,
        modelId: agent.modelId,
        action,
      });
      try {
        return await providers[agent.provider][action]({
          ...context,
          options: agentOptions(options, role),
        });
      } catch (error) {
        if(isAuthenticationFailure(error))await onAuthenticationFailure(agent.provider,context.options);
        if (context.signal?.aborted || !isQuotaExhausted(error)) throw error;
        if (options.autoFallback === true) {
          options.exhaustedProviders ??= [];
          if (!options.exhaustedProviders.includes(agent.provider))
            options.exhaustedProviders.push(agent.provider);
          await options.onProviderExhausted?.(agent.provider);
        }
        if (
          attempt === maximum - 1 ||
          !(await choose(role, action, context, attempted, "quota_exhausted"))
        )
          throw new Error(
            `${PROVIDER_NAMES[agent.provider]} 한도 소진 · 연결된 대체 AI도 사용할 수 없습니다. 작업과 저장된 코드는 보존했습니다. 로그인·모델 연결 또는 한도 갱신 후 다시 시작하세요.`,
          );
      }
    }
  }
  return Object.fromEntries(
    SLOT_IDS.map((role) => [
      role,
      {
        routed: true,
        async ready(options) {
          const agent = teamFor(options).find((row) => row.id === role);
          if (!agent) return false;
          try {
            return await providers[agent.provider].ready(
              agentOptions(options, role),
            );
          } catch (error) {
            if(isAuthenticationFailure(error))await onAuthenticationFailure(agent.provider,options);
            if (!isQuotaExhausted(error)) throw error;
            options.team ??= defaultTeam(options.roles);
            if (options.autoFallback === true) {
              options.exhaustedProviders ??= [];
              if (!options.exhaustedProviders.includes(agent.provider))
                options.exhaustedProviders.push(agent.provider);
            }
            const changes = [];
            const local = {
              ...options,
              onProviderSwitch: (change) => changes.push(change),
            };
            if (
              !(await choose(
                role,
                "plan",
                { options: local },
                new Set([routeKey(agent)]),
                "quota_exhausted",
              ))
            )
              throw new Error(
                "한도 소진 · 대체 AI의 로그인과 모델을 확인하세요.",
              );
            options.runtimeRoutes = local.runtimeRoutes;
            options.preflightSwitches ??= [];
            for (const change of changes)
              options.preflightSwitches.push({
                actor: role,
                from: change.from,
                provider: change.provider,
                ...(change.modelId ? { modelId: change.modelId } : {}),
              });
            return true;
          }
        },
        plan: (context) => invoke(role, "plan", context),
        build: (context) => invoke(role, "build", context),
        review: (context) => invoke(role, "review", context),
        chat: (context) => invoke(role, "chat", context),
      },
    ]),
  );
}
