export function isAuthenticationFailure(error){if(error?.authenticationRequired===true)return true;let text;try{text=JSON.stringify({code:error?.code,status:error?.status,statusCode:error?.statusCode,message:error?.message,rpcMessage:error?.rpcMessage,rpcData:error?.rpcData,error:error?.error,cliFailure:error?.is_error===true||error?.type==='error'?{result:error?.result,errors:error?.errors}:undefined});}catch{return false;}return error?.status===401||error?.statusCode===401||/invalid[_ -]api[_ -]key|unauthenticated|unauthorized|not[_ -]logged[_ -]in|authentication[_ -](?:required|failed|expired|error)|token[_ -]expired|login[_ -]required|HTTP 401/i.test(text??'');}
// Only provider/transport error envelopes enter this classifier, never a model reply.
export function isQuotaExhausted(error) {
  if (error?.quotaExhausted === true) return true;
  let text;
  try {
    text = JSON.stringify({
      code: error?.code,
      message: error?.message,
      rpcMessage: error?.rpcMessage,
      rpcData: error?.rpcData,
      detail: error?.error ?? error,
    });
  } catch {
    return false;
  }
  if (
    /unauthorized|unauthenticated|invalid_api_key|permission_denied|authentication (?:failed|required|expired)|HTTP 40[13]/i.test(
      text,
    )
  )
    return false;
  if (
    /context[_ -]?(?:length|window)|maximum context|output token limit/i.test(
      text,
    )
  )
    return false;
  // Minute-based throttling is temporary even when the message says "quota".
  // A concrete account/daily exhaustion code must be present to override it.
  if (
    /rate_limit_exceeded|requests.?per.?minute|tokens.?per.?minute|per[_ -]minute|too many requests/i.test(text) &&
    !/insufficient_quota|usage_limit_reached|quota_exhausted|credit_balance_too_low|requests.?per.?day|daily quota|weekly quota|monthly quota/i.test(text)
  ) return false;
  return (
    /insufficient_quota|usage_limit_reached|quota_exhausted|credit_balance_too_low/i.test(
      text,
    ) ||
    /(?:exhausted|exceeded|insufficient)[^\n]{0,45}(?:daily |weekly |monthly )?(?:quota|credits|usage allowance)/i.test(
      text,
    ) ||
    (/RESOURCE_EXHAUSTED/.test(text) &&
      /RequestsPerDay|daily quota|remaining[^\n]{0,15}[: ]0/i.test(text)) ||
    /(?:usage|daily|weekly|monthly|token|credit)[ _-]*(?:quota|limit|budget|balance)?[^\n]{0,60}(?:exhausted|depleted|used up|has been reached|limit reached|limit exceeded)/i.test(
      text,
    ) ||
    /(?:quota|usage limit|credit balance)[^\n]{0,45}(?:exceeded|exhausted|depleted|reached|insufficient)/i.test(
      text,
    ) ||
    /you(?:'|’)?ve hit your (?:usage )?limit|no (?:remaining|available) (?:credits|usage|quota)/i.test(
      text,
    )
  );
}
export function providerFailure(provider, detail, message) {
  if(isAuthenticationFailure(detail)){const error=new Error(message||'공식 AI 로그인이 필요합니다.');error.authenticationRequired=true;error.provider=provider;return error;}
  if (!isQuotaExhausted(detail))
    return detail instanceof Error ? detail : new Error(message);
  const error = new Error(message || "AI 사용 한도를 소진했습니다.");
  error.code = "provider_quota_exhausted";
  error.quotaExhausted = true;
  error.provider = provider;
  return error;
}
