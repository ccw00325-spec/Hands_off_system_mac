import { validateTeam, exclusiveTeam } from './team.js';

export function roleSummary(team) {
  return { gpt: team[0].provider, grok: team.find(row => row.roles.includes('feature')).provider, claude: team.find(row => row.roles.includes('ui')).provider };
}

export function rememberTeam(data, project, value) {
  const team = validateTeam(value, { exclusive: true });
  project.team = team;
  project.roles = roleSummary(team);
  // Public configuration only: no account, folder grant or execution consent.
  data.lastTeam = structuredClone(team);
  return team;
}

export function inheritedTeam(data) {
  const value = data.lastTeam ?? data.items.find(row => row.id === data.activeId)?.team;
  if (!value) return null;
  try { return validateTeam(exclusiveTeam(value), { exclusive: true }); }
  catch { throw new Error('저장된 AI 구성을 읽지 못했습니다. AI 역할 변경에서 구성을 다시 저장한 뒤 새 프로젝트를 만들어 주세요.'); }
}
