const pages = [
  {
    id: "start",
    title: "처음 시작하기",
    image: "workspace",
    heading: "폴더를 고르고, 만들고 싶은 것을 말하세요.",
    body: "Hands off는 여러 AI에게 설명을 옮겨 붙이는 일을 줄이는 로컬 작업 공간입니다. 컨트롤 타워가 명세를 정리하고, 작업 AI가 구현한 뒤 테스트와 검토로 확인합니다.",
    items: [
      [
        "필수 프로그램 설치",
        "우측 상단에서 준비 상태를 확인합니다. 빨간 필수 도구가 모두 준비되어야 AI 작업을 시작할 수 있습니다. 빠진 도구가 있으면 설치 팝업과 우측 알림으로 안내하며, 창을 닫아도 작업은 차단됩니다. 노란 선택 도구는 없어도 됩니다.",
      ],
      [
        "새 프로젝트",
        "빈 폴더를 선택하고 소스 전달 범위를 확인합니다. 생성한 파일은 이 폴더에 저장됩니다.",
      ],
      [
        "계정 · 연결",
        "이 컴퓨터의 공식 CLI 로그인을 확인합니다. 같은 GPT 계정을 여러 패널에 써도 됩니다.",
      ],
      [
        "작업 요청",
        "“독서 기록 앱에 검색과 통계를 넣어줘”처럼 요청합니다. 질문만 모드는 코드를 바꾸지 않습니다.",
      ],
      [
        '/fun 질문과 답변',
        '빈칸이 있으면 구현을 멈추고 선택지·직접 입력 팝업을 엽니다. 나중에 답변으로 닫고 채팅창 아래 질문에 답변하기로 다시 열 수 있습니다. /mut 옆 /fun 체크를 해제하면 새 작업은 해당 스킬 없이 진행합니다.',
      ],
    ],
    action: "project",
    button: "새 프로젝트 시작",
  },
  {
    id: "team",
    title: "AI·모델·역할",
    image: "roles",
    heading: "AI를 고르면 모델이 자동으로 나타납니다.",
    body: "기본값은 GPT 컨트롤 타워, Cursor 기능 구현, Claude UI 구현의 세 패널입니다. 2~4개로 조절할 수 있습니다. 컨트롤 타워는 01번에 고정되고 AI는 바꿀 수 있습니다.",
    items: [
      [
        "GPT 모델 선택",
        "앱 시작 시 흰색 시작 창에서 모델 목록을 준비합니다. 계정 연결·역할 설정·채팅창은 같은 목록에서 바로 선택하며 별도의 모델 조회 버튼은 없습니다. 로그인이나 실행 계정을 바꾸면 자동으로 갱신합니다. “GPT 자동 선택”은 현재 계정의 CLI 실행 설정을 따른다는 뜻입니다.",
      ],
      [
        "담당 업무 체크",
        "기능 구현과 UI 구현·연결은 각각 한 패널만 선택합니다. 담당을 옮기려면 기존 체크를 먼저 해제하세요. 디버깅·코드 검토·테스트는 중복 가능합니다.",
      ],
      [
        "한도 부족 자동 인계",
        "수치를 제공하는 연결은 새 요청 전 잔여 한도를 확인합니다. 5% 이하이면 여유 있는 팀 AI를 찾고, 실제 소진 시에도 같은 작업으로 재요청합니다. 수치 미지원은 추정하지 않습니다.",
      ],
      [
        "대체 AI 우선순위",
        "직접 정하지 않아도 연결된 팀을 확인합니다. 정해둔 AI는 먼저 시도합니다. 다른 공급자에게 같은 명세와 소스가 전달될 수 있습니다. Cursor가 UI 구현을 맡게 되면 취소/진행을 먼저 묻습니다.",
      ],
    ],
    action: "roles",
    button: "AI 설정 열기",
  },
  {
    id: "chat",
    title: "대화·진행 상황",
    image: "output",
    heading: "로고를 누르면 그 AI의 실제 작업을 읽습니다.",
    body: "가운데는 컨트롤 타워 대화이고 오른쪽에는 AI별 작업이 세로로 쌓입니다. 상태는 대기, 진행 중, 구현 완료, 전체 검증 후 완료로 구분합니다.",
    items: [
      [
        "AI 로고·작업 이름",
        "로그와 개별 질문 창을 팝업으로 엽니다. 작업 이름을 누르면 변경 파일과 완료 기준도 보입니다. 컨트롤 타워 팝업은 가운데와 같은 대화입니다.",
      ],
      [
        "박스를 든 캐릭터",
        "실제 업무 배정과 완료 보고가 발생했을 때 곡선을 따라 왕복합니다. 애니메이션 자체는 성공의 근거가 아닙니다.",
      ],
      [
        "종 알림",
        "화면 알림은 10초 뒤 사라집니다. 종을 누르면 기록을 다시 보고, 마우스를 올리면 휴지통으로 지울 수 있습니다. 전부 지우기는 알림만 삭제합니다.",
      ],
      [
        "대화 기록",
        "왼쪽 폴더 아래 이전 대화를 선택합니다. 새 대화는 같은 프로젝트 안의 별도 대화이며, 기록 관리에서 보관·내보내기·삭제합니다.",
      ],
    ],
  },
  {
    id: "design",
    title: "UI 시안",
    image: "design",
    heading: "코드를 만들기 전에 화면 방향을 확인하세요.",
    body: "기본값은 이미지 API를 쓰지 않는 텍스트 구조안입니다. 승인 설정이 켜져 있으면 구현 전에 기다립니다. 왼쪽 UI 시안에서 구조를 확인하고, 필요할 때만 이미지 생성을 요청하세요.",
    items: [
      [
        "이미지 키 연결",
        "텍스트 구조안에는 키가 필요 없습니다. 이미지로 보고 싶을 때만 GPT Image 또는 Gemini 이미지 키를 등록하세요. CLI 구독과 이미지 API 과금은 별개입니다.",
      ],
      [
        "다시 생성",
        "“목록을 더 넓게, 강조색은 민트로”처럼 수정 사항을 적습니다. 원하는 시안이 나올 때까지 승인하지 않아도 됩니다.",
      ],
      [
        "이대로 적용",
        "컨트롤 타워에 이 문구를 보내면 승인한 시안과 명세를 작업 AI에 전달합니다. PNG 내보내기로 이미지만 저장할 수도 있습니다.",
      ],
    ],
    action: "design",
    button: "UI 시안 열기",
  },
  {
    id: "test",
    title: "테스트·뮤테이션",
    image: "test-report",
    heading: "“완료했다”는 말과 실제 검증을 구분합니다.",
    body: "컨트롤 타워에는 테스트 설계·실행이 기본 배정됩니다. 테스트 파일, 각 단언의 통과·실패, 실행 명령과 재현 절차를 보고 결과를 판단하세요.",
    items: [
      [
        "테스트 설계·실행",
        "전역 동의와 현재 폴더의 개별 승인이 필요합니다. 기본은 Docker 격리이며 도구나 이미지가 없으면 보류합니다. PC 직접 실행은 별도 위험 확인을 받아야 합니다.",
      ],
      [
        "실패와 자동 수정",
        "실패 로그를 담당 AI에게 전달하고 설정한 횟수만큼 다시 확인합니다. 해결되지 않으면 확인 필요 상태로 멈춥니다.",
      ],
      [
        "뮤테이션 테스트 · 고급 선택 옵션",
        "작은 코드 변형을 넣어 기존 테스트가 버그를 잡는지 확인합니다. 핵심 비즈니스 로직을 대상으로 프로젝트에 StrykerJS와 test:mutation 스크립트 및 JSON 보고 설정이 필요합니다.",
      ],
      [
        "설정이 없는 프로젝트",
        "일반 테스트가 기본 완료 기준입니다. 채팅창 아래 /mut 뮤테이션 테스트를 선택할 수 있고, 선택했는데 미설정이면 통과로 처리하지 않습니다.",
      ],
    ],
    action: "testing",
    button: "현재 검증 결과 보기",
  },
  {
    id: "restore",
    title: "Workflow·복원",
    image: "workflow",
    heading: "작업이 꼬이면 복원할 파일부터 확인하세요.",
    body: "Workflow 보기는 작업의 선행 조건, 담당 AI, 검증과 최종 검토를 한곳에 보여줍니다. 항상 펼쳐두지 않아도 됩니다.",
    items: [
      [
        "Workflow 보기",
        "작업을 시작하면 컨트롤 타워 제목 옆 버튼이 활성화됩니다. 노드를 누르면 해당 AI와 변경 보고를 확인합니다.",
      ],
      [
        "체크포인트",
        "작업별 변경과 마지막 검증 통과 지점에서 복원 미리보기를 엽니다. 되돌릴 파일을 확인한 뒤 복원합니다.",
      ],
      [
        "사용자 수정과 충돌",
        "나중에 직접 수정한 파일과 충돌하면 복원을 멈춥니다. 복원 뒤에는 이전 검증과 배포 승인을 그대로 재사용하지 않고 다시 확인합니다.",
      ],
    ],
    action: "checkpoints",
    button: "체크포인트 열기",
  },
  {
    id: "services",
    title: "GitHub·배포",
    image: "services",
    heading: "코드를 만들고 검증한 다음, 보낼 곳을 확인합니다.",
    body: "왼쪽 보조 서비스 연결에서 현재 컴퓨터의 공식 CLI 계정을 확인합니다. 서비스 사용 여부와 대상은 프로젝트별로 정합니다.",
    items: [
      [
        "GitHub",
        "검증된 코드를 커밋·푸시합니다. 새 저장소는 이름과 계정을 확인하는 승인 창을 거칩니다.",
      ],
      [
        "Vercel",
        "미리보기 또는 운영 배포 대상을 확인하고 예/아니요로 선택합니다. Supabase는 연결 상태와 프로젝트 참조 ID를 관리하며 DB 변경은 CLI에서 진행합니다.",
      ],
      [
        "다음부터 묻지 않기",
        "현재 프로젝트와 같은 전송 대상에서만 자동 승인합니다. 네트워크가 끊겨도 로컬 작업은 보존하며 실패한 전송 단계만 재시도합니다.",
      ],
    ],
    action: "delivery",
    button: "보조 서비스 확인",
  },
  {
    id: "limits",
    title: "사용량·설정·보안",
    image: "settings",
    heading: "계정 한도와 이 작업의 호출 수는 다른 수치입니다.",
    body: "상단의 5시간/주간 잔여 한도는 공식 데이터가 있을 때만 표시합니다. 10초마다 갱신을 시도하지만 CLI 조회 지연이나 미지원인 경우가 있습니다.",
    items: [
      [
        "이번 작업 사용량",
        "Workflow에서 실패·대체 요청을 포함한 호출 수와 공급자가 제공하는 토큰을 확인합니다. 구독 잔여량을 금액으로 환산하지 않습니다.",
      ],
      [
        "호출 수·API 예산",
        "설정에서 호출 상한과 자동 수정 횟수를 정합니다. GPT API 비용은 모델과 단가가 확인되는 경우에만 추정하며 현재 진행 중인 요청은 상한을 넘길 수 있습니다.",
      ],
      [
        "로그인과 키",
        "공식 CLI는 현재 OS 사용자의 로그인을 재사용합니다. 앱의 키는 OS 보안 저장소로 암호화합니다. 다른 OS 사용자의 로그인 프로필을 배포 파일에 넣지 않습니다.",
      ],
      [
        "작업 폴더",
        "같은 PC라도 OS 계정을 공유하면 CLI 세션을 공유할 수 있습니다. 신뢰하는 프로젝트에서만 코드 실행을 승인하세요.",
      ],
    ],
    action: "settings",
    button: "작업 환경 설정",
  },
];
const node = (tag, text) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};
export function createGuide(onAction) {
  const nav = document.querySelector("#guide-nav"),
    body = document.querySelector("#guide-content");
  function render(index) {
    const page = pages[index];
    body.replaceChildren(node("h3", page.heading), node("p", page.body));
    const figure = node("figure"),
      image = node("img");
    image.src = `assets/guide/${page.image}.png`;
    image.alt = page.title + " 실제 앱 예제 화면";
    image.loading = "lazy";
    figure.append(
      image,
      node(
        "figcaption",
        "실제 앱의 예제 화면입니다. AI 응답과 연결 상태는 테스트용이며 개인 계정·키를 포함하지 않습니다.",
      ),
    );
    body.append(figure);
    const list = node("dl");
    for (const [label, description] of page.items)
      list.append(node("dt", label), node("dd", description));
    body.append(list);
    if (page.action) {
      const action = node("button", page.button);
      action.type = "button";
      action.className = "primary";
      action.onclick = () => {
        document.querySelector("#guide-dialog").close();
        onAction(page.action);
      };
      body.append(action);
    }
    for (const [at, button] of [...nav.children].entries()) {
      button.setAttribute("aria-current", at === index ? "page" : "false");
    }
    document.querySelector("#guide-dialog").scrollTop = 0;
  }
  pages.forEach((page, index) => {
    const button = node("button", page.title);
    button.type = "button";
    button.dataset.guide = page.id;
    button.onclick = () => render(index);
    nav.append(button);
  });
  render(0);
}
