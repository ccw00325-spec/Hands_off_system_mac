export const PROVIDERS = {
  gpt: "GPT",
  claude: "Claude",
  grok: "Grok · Cursor",
  gemini: "Gemini",
};
export const CAPABILITIES = {
  control: "컨트롤 타워",
  feature: "기능 구현",
  ui: "UI 구현·연결",
  debug: "디버깅",
  review: "코드 검토",
  test: "테스트 설계·실행",
  critic:"비판적 검증",
};
export const SLOT_IDS = ["gpt", "grok", "claude", "reviewer"];
export function validateModelId(value) {
  if (
    typeof value !== "string" ||
    value.length > 250 ||
    value.startsWith("-") ||
    /[\s\x00-\x1f]/.test(value)
  )
    throw new Error("실행 모델 ID 형식이 올바르지 않습니다.");
  return value;
}
export function defaultTeam(
  roles = { gpt: "gpt", grok: "grok", claude: "claude" },
) {
  return [
    { id: "gpt", provider: roles.gpt, roles: ["control", "debug", "review", "test"] },
    { id: "grok", provider: roles.grok, roles: ["feature", "debug", "review"] },
    { id: "claude", provider: roles.claude, roles: ["ui", "review", "critic"] },
  ];
}
export function validateTeam(team, { exclusive = false } = {}) {
  if (!Array.isArray(team) || team.length < 2 || team.length > 4)
    throw new Error("작업 패널은 2~4개로 구성하세요.");
  const normalized = team.map((agent, index) => {
    if (
      !agent ||
      agent.id !== SLOT_IDS[index] ||
      !Object.hasOwn(PROVIDERS, agent.provider) ||
      !Array.isArray(agent.roles) ||
      !agent.roles.length ||
      agent.roles.some((role) => !Object.hasOwn(CAPABILITIES, role)) ||
      new Set(agent.roles).size !== agent.roles.length
    )
      throw new Error("패널의 AI와 역할 구성이 올바르지 않습니다.");
    if (
      (index === 0 && !agent.roles.includes("control")) ||
      (index !== 0 && agent.roles.includes("control"))
    )
      throw new Error("컨트롤 타워는 첫 번째 패널에 배정하세요.");
    if (agent.modelId !== undefined) validateModelId(agent.modelId);
    let fallback;
    if (agent.fallback !== undefined) {
      const next = agent.fallback;
      if (!next || !Object.hasOwn(PROVIDERS, next.provider))
        throw new Error("대체 AI 공급자를 확인하세요.");
      if (next.modelId !== undefined) validateModelId(next.modelId);
      if (next.provider === agent.provider && (next.modelId || "") === (agent.modelId || ""))
        throw new Error("대체 AI는 기본 AI와 다른 공급자 또는 모델로 선택하세요.");
      fallback = { provider: next.provider, ...(next.modelId ? { modelId: next.modelId } : {}) };
    }
    return {
      id: agent.id,
      provider: agent.provider,
      roles: [...agent.roles],
      ...(agent.modelId ? { modelId: agent.modelId } : {}),
      ...(fallback ? { fallback } : {}),
    };
  });
  if (
    ["feature", "ui"].some(
      (role) => !normalized.some((agent) => agent.roles.includes(role)),
    )
  )
    throw new Error(
      "기능 구현과 UI 구현 역할을 각각 한 패널 이상에 배정하세요. 한 패널에 함께 배정할 수 있습니다.",
    );
  if(exclusive && ["feature","ui"].some(role=>normalized.filter(agent=>agent.roles.includes(role)).length!==1))
    throw new Error("기능 구현과 UI 구현·연결은 각각 한 AI 패널에만 배정하세요.");
  return normalized;
}
// Old run snapshots remain readable; new settings migrate to single implementation owners.
export function exclusiveTeam(team) {
  const normalized=validateTeam(team);const owned=new Set();
  return normalized.map(agent=>{
    const roles=agent.roles.filter(role=>{
      if(!["feature","ui"].includes(role))return true;
      if(owned.has(role))return false;owned.add(role);return true;
    });
    return {...agent,roles:roles.length?roles:["review"]};
  });
}
export function teamFor(options = {}) {
  const team = validateTeam(options.team ?? defaultTeam(options.roles));
  return team.map((agent) => {
    const route = options.runtimeRoutes?.[agent.id];
    if (!route) return agent;
    const same=next=>next?.provider===route.provider&&(next.modelId||"")===(route.modelId||"");
    if (!same(agent.fallback) && !(options.autoFallback===true && team.some(same)))
      throw new Error("저장된 대체 AI 경로와 역할 설정이 일치하지 않습니다.");
    const { modelId: _old, ...rest } = agent;
    return { ...rest, provider: route.provider, ...(route.modelId ? { modelId: route.modelId } : {}) };
  });
}
export function resizeTeam(team, count) {
  if (!Number.isInteger(count) || count < 2 || count > 4)
    throw new Error("패널 수는 2~4개입니다.");
  const result = validateTeam(team)
    .slice(0, count)
    .map((agent) => ({ ...agent, roles: [...agent.roles] }));
  while (result.length < count) {
    const index = result.length;
    result.push({
      id: SLOT_IDS[index],
      provider: result[0].provider,
      roles: index === 2 && !result.some(agent=>agent.roles.includes("ui")) ? ["ui", "review"] : ["debug", "review", "critic"],
    });
  }
  for (const role of ["feature", "ui"])
    if (!result.some((agent) => agent.roles.includes(role)))
      (role === 'ui'
        ? [...result].sort((a,b)=>(['claude','gpt','gemini','grok'].indexOf(a.provider)-['claude','gpt','gemini','grok'].indexOf(b.provider)) || Number(a.id==='gpt')-Number(b.id==='gpt'))[0]
        : result[1]).roles.push(role);
  for (const agent of result)
    agent.roles = [...new Set([...agent.roles, 'debug', 'review', 'test'])];
  if(!result.some(agent=>agent.roles.includes('critic')))result[1].roles.push('critic');
  return validateTeam(exclusiveTeam(result),{exclusive:true});
}
export function agentLabel(agent) {
  return `${PROVIDERS[agent.provider]} · ${agent.roles.map((role) => CAPABILITIES[role]).join(" / ")}`;
}
export function agentOptions(options, id) {
  const agent = teamFor(options).find((row) => row.id === id);
  if (!agent) throw new Error("현재 팀에 없는 패널입니다.");
  const value = { ...options, agentId: id, assignedRoles: agent.roles };
  if (agent.modelId) {
    if (agent.provider === "gpt") value.gptModel = agent.modelId;
    if (agent.provider === "claude") value.claudeModel = agent.modelId;
    if (agent.provider === "gemini") value.geminiModel = agent.modelId;
    if (agent.provider === "grok")
      value.grokRoute = { source: "cursor", modelId: agent.modelId };
  }
  return value;
}
