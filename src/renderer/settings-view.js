const $ = (selector) => document.querySelector(selector);
export function fillPreferences(value) {
  $("#max-repair-rounds").value = value.maxRepairRounds;
  $("#max-agent-calls").value = value.maxAgentCalls;
  $('#max-daily-calls').value = value.maxDailyCalls;
  $('#max-image-calls').value = value.maxImageCallsPerDay;
  $('#max-output-tokens').value = value.maxOutputTokens;
  $('#daily-api-budget').value = value.dailyApiBudgetUsd;
  $('#execution-backend').value = value.executionBackend;
  $('#docker-image').value = value.dockerImage;
  $('#design-mode').value = value.designMode;
  $('#mutation-by-default').checked = value.mutationByDefault;
  $('#mutation-option').checked = value.mutationByDefault;
  $('#fun-option').checked = value.funByDefault;
  $("#max-concurrent-agents").value = value.maxConcurrentAgents;
  $("#api-budget").value = value.apiBudgetUsd;
  $("#api-rate-model").value = value.apiRateModel;
  $("#api-input-rate").value = value.apiInputRate;
  $("#api-output-rate").value = value.apiOutputRate;
  $("#validation-script").value = value.validationScript;
  $("#allow-execution").checked = value.allowExecution;
  $("#unattended-mode").checked = value.unattended;
  $("#design-approval").checked = value.designApproval;
  $('#visual-review-default').checked = value.visualReview !== false;
  $("#terminal-font-size").value = String(value.terminalFontSize);
  $("#wrap-lines").checked = value.wrapLines;
  document.documentElement.style.setProperty(
    "--terminal-font-size",
    value.terminalFontSize + "px",
  );
  document.body.dataset.wrap = value.wrapLines ? "on" : "off";
  $("#settings-intro").textContent = value.onboardingComplete
    ? "작업 설정은 다음 작업, 일일 한도는 새 호출부터 적용됩니다. 재검증은 현재 실행 위치를 따릅니다. 실행 동의 취소 시 현재 검증도 중지합니다."
    : "처음 한 번 작업 환경과 실행 권한을 선택하세요. 실행 동의는 선택 사항이며 나중에 바꿀 수 있습니다.";
}
export function readPreferences() {
  return {
    maxRepairRounds: Number($("#max-repair-rounds").value),
    maxAgentCalls: Number($("#max-agent-calls").value),
    maxDailyCalls: Number($('#max-daily-calls').value),
    maxImageCallsPerDay: Number($('#max-image-calls').value),
    maxOutputTokens: Number($('#max-output-tokens').value),
    dailyApiBudgetUsd: Number($('#daily-api-budget').value),
    executionBackend: $('#execution-backend').value,
    dockerImage: $('#docker-image').value.trim(),
    designMode: $('#design-mode').value,
    mutationByDefault: $('#mutation-by-default').checked,
    funByDefault: $('#fun-option').checked,
    maxConcurrentAgents: Number($("#max-concurrent-agents").value),
    apiBudgetUsd: Number($("#api-budget").value),
    apiRateModel: $("#api-rate-model").value.trim(),
    apiInputRate: Number($("#api-input-rate").value),
    apiOutputRate: Number($("#api-output-rate").value),
    validationScript: $("#validation-script").value.trim(),
    allowExecution: $("#allow-execution").checked,
    unattended: $("#unattended-mode").checked,
    designApproval: $("#design-approval").checked,
    visualReview: $('#visual-review-default').checked,
    terminalFontSize: Number($("#terminal-font-size").value),
    wrapLines: $("#wrap-lines").checked,
  };
}
