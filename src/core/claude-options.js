// Keep the original CLI's OAuth/keychain authentication enabled. --bare disables it.
export function officialClaudeArgs() {
  return [
    "--tools",
    "",
    "--setting-sources",
    "",
    "--settings",
    '{"disableAllHooks":true,"enabledPlugins":{}}',
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-chrome",
    "--no-session-persistence",
  ];
}

// Image input requires bidirectional stream-json in current official CLI builds.
// Only the final result envelope is a verdict; init/assistant events are not.
export function claudeResultEnvelope(text,stream=false){
  try{
    if(!stream)return JSON.parse(text);
    const results=text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='result');
    if(results.length===1)return results[0];
  }catch{}
  throw new Error('Claude의 최종 JSON 결과를 확인하지 못했습니다. CLI 연결과 출력 형식을 확인하세요.');
}
