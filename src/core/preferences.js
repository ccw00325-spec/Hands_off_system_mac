import { deviceBinding } from "./device-binding.js";
export const DEFAULT_PREFERENCES = Object.freeze({
  version: 1,
  onboardingComplete: false,
  maxRepairRounds: 2,
  maxAgentCalls: 120,
  maxDailyCalls: 300,
  dailyApiBudgetUsd: 0,
  maxOutputTokens: 16384,
  maxImageCallsPerDay: 5,
  maxConcurrentAgents: 4,
  apiBudgetUsd: 0,
  apiInputRate: 0,
  apiOutputRate: 0,
  apiRateModel: "",
  validationScript: "test",
  allowExecution: false,
  unattended: true,
  designApproval: true,
  designMode: 'layout',
  visualReview: true,
  mutationByDefault: false,
  funByDefault: true,
  engineeringGates: true,
  autopilotEnabled: true,
  executionBackend: 'docker',
  dockerImage: 'node:24-bookworm-slim',
  terminalFontSize: 13,
  wrapLines: true,
});
export class Preferences {
  constructor(store, identity = deviceBinding) {
    this.store = store;
    this.identity = identity;
  }
  async get() {
    const saved = await this.store.read("preferences", {});
    const value = { ...DEFAULT_PREFERENCES, ...saved };
    if (saved.consentBinding !== (await this.identity())) {
      value.allowExecution = false;
      value.onboardingComplete = false;
    }
    delete value.consentBinding;
    return value;
  }
  async save(input) {
    if (
      !input ||
      !Number.isInteger(input.maxRepairRounds) ||
      input.maxRepairRounds < 0 ||
      input.maxRepairRounds > 20 ||
      (input.maxConcurrentAgents !== undefined && ![1, 2, 3, 4].includes(input.maxConcurrentAgents)) ||
      (input.maxAgentCalls !== undefined && (!Number.isInteger(input.maxAgentCalls) || input.maxAgentCalls < 5 || input.maxAgentCalls > 500)) ||
      ["apiBudgetUsd", "apiInputRate", "apiOutputRate"].some((key) => input[key] !== undefined && (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 10000)) ||
      (input.apiRateModel !== undefined && (typeof input.apiRateModel !== "string" || !/^[\w.:-]{0,150}$/.test(input.apiRateModel))) ||
      (input.apiBudgetUsd > 0 && (!input.apiRateModel || !(input.apiInputRate > 0 || input.apiOutputRate > 0))) ||
      (input.designApproval !== undefined && typeof input.designApproval !== "boolean") ||
      (input.designMode !== undefined && !['layout', 'image'].includes(input.designMode)) ||
      (input.visualReview !== undefined && typeof input.visualReview !== 'boolean') ||
      (input.executionBackend !== undefined && !['docker', 'host'].includes(input.executionBackend)) ||
      (input.dockerImage !== undefined && (typeof input.dockerImage !== 'string' || input.dockerImage.length > 200 || !/^[a-z0-9][a-z0-9./_:-]*(?:@sha256:[a-f0-9]{64})?$/.test(input.dockerImage))) ||
      (input.mutationByDefault !== undefined && typeof input.mutationByDefault !== 'boolean') ||
      (input.funByDefault !== undefined && typeof input.funByDefault !== 'boolean') ||
      (input.engineeringGates !== undefined && typeof input.engineeringGates !== 'boolean') ||
      (input.autopilotEnabled !== undefined && typeof input.autopilotEnabled !== 'boolean') ||
      (input.maxDailyCalls !== undefined && (!Number.isInteger(input.maxDailyCalls) || input.maxDailyCalls < 5 || input.maxDailyCalls > 5000)) ||
      (input.maxOutputTokens !== undefined && (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1024 || input.maxOutputTokens > 65536)) ||
      (input.maxImageCallsPerDay !== undefined && (!Number.isInteger(input.maxImageCallsPerDay) || input.maxImageCallsPerDay < 0 || input.maxImageCallsPerDay > 100)) ||
      (input.dailyApiBudgetUsd !== undefined && (!Number.isFinite(input.dailyApiBudgetUsd) || input.dailyApiBudgetUsd < 0 || input.dailyApiBudgetUsd > 10000)) ||
      (input.dailyApiBudgetUsd > 0 && (!input.apiRateModel || !(input.apiInputRate > 0 || input.apiOutputRate > 0))) ||
      typeof input.validationScript !== "string" ||
      (input.validationScript &&
        !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(input.validationScript)) ||
      ![12, 13, 14, 16, 18].includes(input.terminalFontSize) ||
      ["allowExecution", "unattended", "wrapLines"].some(
        (key) => typeof input[key] !== "boolean",
      )
    )
      throw new Error("작업 설정의 횟수·스크립트·글꼴 또는 권한을 확인하세요.");
    const value = {
      ...DEFAULT_PREFERENCES,
      ...Object.fromEntries(
        Object.keys(DEFAULT_PREFERENCES)
          .filter((key) => key in input)
          .map((key) => [key, input[key]]),
      ),
      version: 1,
      onboardingComplete: true,
      consentBinding: await this.identity(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.write("preferences", value);
    return this.get();
  }
  async setFunDefault(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('/fun 켜기·끄기 값을 확인하세요.');
    const saved = await this.store.read('preferences', {});
    await this.store.write('preferences', { ...saved, funByDefault: enabled });
    return this.get();
  }
  async setAutopilotDefault(enabled){if(typeof enabled!=='boolean')throw new Error('자동 수락 켜기·끄기 값을 확인하세요.');const saved=await this.store.read('preferences',{});await this.store.write('preferences',{...saved,autopilotEnabled:enabled});return this.get();}
}
