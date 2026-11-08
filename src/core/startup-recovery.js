import { validateTeam } from './team.js';

export function disconnectedTeam(team, connections) {
  const seen = new Set();
  return team.filter(row => {
    if (seen.has(row.provider)) return false;
    seen.add(row.provider);
    return connections[row.provider]?.connected !== true;
  }).map(row => ({ actor: row.id, provider: row.provider, state: connections[row.provider]?.state ?? 'unknown', installed: connections[row.provider]?.installed !== false,
    actors: team.filter(agent => agent.provider === row.provider).map(agent => agent.id) }));
}

export function replaceTeamProvider(team, previous, provider, modelId = '') {
  if (provider === previous || !team.some(row => row.provider === previous)) throw new Error('교체할 AI와 새로운 AI를 확인하세요.');
  return validateTeam(team.map(row => {
    const next = { ...row, roles: [...row.roles] };
    if (row.provider === previous) {
      next.provider = provider;
      delete next.modelId;
      if (modelId) next.modelId = modelId;
    }
    // Retiring an AI also removes routes which could select it on a later run.
    if (next.fallback?.provider === previous || next.fallback?.provider === next.provider && (next.fallback.modelId ?? '') === (next.modelId ?? '')) delete next.fallback;
    return next;
  }), { exclusive: true });
}
