export function preferenceQuestion(question,source){
 const text=question?.prompt??'';
 return source!=='critical-challenge'&&source!=='test-first'&&
  /색상|테마|글꼴|폰트|간격|표시 형식|표시형식|날짜 표시|날짜표시|정렬 순서|정렬순서|color|theme|typography|spacing|display format/i.test(text)&&
  !/권한|승인|계정|로그인|비밀|키|삭제|덮어|배포|푸시|결제|구매|공유|전송|개인정보|보안|폴더|경로|인증|예산|한도|비용|재시도|정책|접근|permission|secret|token|delete|deploy|publish|payment|credential|directory|file|upload|budget|quota|limit|cost|retry|policy/i.test(text+' '+(question.options??[]).join(' '));
}
