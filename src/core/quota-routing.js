import { validateTeam } from "./team.js";
export function remainingQuota(snapshot, provider, options = {}) {
  const key =
    provider === "gpt" && options.gptSource !== "api" ? "codex" : provider;
  const data = snapshot?.providers?.[key];
  if (
    !data ||
    data.state !== "available" ||
    !data.checkedAt ||
    Date.now() - Date.parse(data.checkedAt) > 120000 ||
    !Number.isFinite(Date.parse(data.checkedAt))
  )
    return null;
  const rows = (data.meters ?? []).filter(
    (row) =>
      row.active !== false &&
      Number.isFinite(row.remainingPercent) &&
      row.remainingPercent >= 0 &&
      row.remainingPercent <= 100,
  );
  if (
    rows.some((row) => row.resetsAt && Date.parse(row.resetsAt) <= Date.now())
  )
    return null;
  if (rows.length) return Math.min(...rows.map((row) => row.remainingPercent));
  return Number.isFinite(data.remainingPercent) &&
    data.remainingPercent >= 0 &&
    data.remainingPercent <= 100
    ? data.remainingPercent
    : null;
}
export function replacementCandidates(
  options,
  actor,
  action,
  task,
  snapshot,
  attempted = new Set(),
  proactive = false,
) {
  const team = validateTeam(options.team),
    slot = team.find((row) => row.id === actor),
    required =
      action === "plan"
        ? "control"
        : action === "review"
          ? (task?.kind === 'ui' ? 'ui' : 'review')
          : (task?.kind ?? "debug");
  const routes = [];
  if (slot.fallback) routes.push({ ...slot.fallback, preferred: true });
  if (options.autoFallback === true)
    routes.push(
      ...team.map((row) => ({
        provider: row.provider,
        ...(row.modelId ? { modelId: row.modelId } : {}),
        fit: row.roles.includes(required),
      })),
    );
  const seen = new Set();
  return routes
    .filter((row) => {
      const key = row.provider + ":" + (row.modelId ?? "");
      if (
        seen.has(key) ||
        attempted.has(key) ||
        options.exhaustedProviders?.includes(row.provider)
      )
        return false;
      seen.add(key);
      row.remaining = remainingQuota(snapshot, row.provider, options);
      return (
        row.remaining !== 0 &&
        (!proactive || (row.remaining !== null && row.remaining > 5))
      );
    })
    .sort(
      (a, b) =>
        Number(b.preferred ?? false) - Number(a.preferred ?? false) ||
        Number(b.fit ?? false) - Number(a.fit ?? false) ||
        (b.remaining ?? -1) - (a.remaining ?? -1),
    );
}
