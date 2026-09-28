# ScheduleAlertBot 기획 & 계획

> 이 문서는 계속 갱신됩니다. 기획/설계가 바뀌면 이 파일을 먼저 고치고 코드를 맞춥니다.

## Context
Google Calendar 일정을 매일 아침 요약해서 Discord와 카카오톡으로 보내고, 오늘 일정이 바뀌면 다시 알려주는 개인용 봇이다.

## 확정된 요구사항
- 언어: **Node.js + TypeScript**
- 실행: **내 Mac에서 상시 실행** (launchd)
- 매일 **06:00 (Asia/Seoul)**에 오늘 일정 전체 목록 발송
- 06:00 이후 **오늘 일정이 바뀌면** 다음처럼 알린다.
  - Discord: 아침에 보낸 메시지를 **수정(edit)**하고, 변경 표시를 덧붙인다.
  - 카카오톡: 메시지 수정이 안 되므로 **업데이트된 오늘 일정 전체를 다시 발송**한다. (2단계)
- 카카오톡은 알림이 울려야 한다. '나에게 보내기'는 알림이 울리지 않으므로 **친구 메시지 API**를 쓴다. (2단계)

## 단계 구분
- **1단계 (완료):** Google Calendar 연동, Discord 봇, 스케줄러 + 폴링, launchd 상시 실행. 카카오는 `Notifier` 인터페이스만 두고 구현하지 않는다.
- **1.5단계 (완료):** `/일정추가`, `/일정목록`, `/일정수정`, `/일정삭제` 자연어 명령어로 캘린더 CRUD.
- **1.6단계 (완료):** 기상청 날씨 연동 — 06시 발송에 오늘 날씨(우산/빨래 여부) 포함, `/오늘날씨` 명령어.
- **2단계 (나중에):** 카카오톡 연동. 봇 계정 → 내 계정 친구 메시지 방식을 유력 후보로 본다. 착수 전 최신 공식 문서로 재검증한다.

## 진행 현황
- [x] 기획 확정, plan.md 작성
- [x] 프로젝트 초기화 (package.json, tsconfig, .env.example, .gitignore)
- [x] Google Calendar 연동 (OAuth + getTodayEvents) — 인증 완료, dry-run 테스트 확인
- [x] Discord 봇 (발송/수정 + `/오늘일정` 명령어) — 서버 초대·권한 설정, 실제 발송/명령어 등록 완료
- [x] state 저장 + 스케줄러(06:00 + 5분 폴링) + 캐치업 — 캐치업 발송, 폴링 변경 감지(🆕 표시) 실기 테스트로 확인
- [x] launchd 등록, 설치 문서 — `~/Library/LaunchAgents`에 등록, 재부팅에도 자동 실행됨
- [x] `/일정추가` 자연어 일정 등록 — Google 쓰기 권한 재인증 완료
- [x] `/일정목록`, `/일정수정`, `/일정삭제` — 검색·수정·삭제(확인 버튼 포함), 실사용 테스트 완료 (2026-09-28)
- [x] 기상청 날씨 연동 (`/오늘날씨`, 06시 발송에 포함) — 인천 검단구 원당동 기준, API 허브 인증 완료, 명령어 실사용 테스트 완료 (2026-09-28)
- [ ] (2단계) 카카오톡 연동

**1단계 완료 (2026-09-28).** 실제 사용 중 이슈가 생기면 여기 기록하고, 카카오톡 착수 시 2단계 섹션부터 다시 진행한다.

## 1.5단계: 자연어 캘린더 CRUD (`/일정추가` `/일정목록` `/일정수정` `/일정삭제`)

### 배경
캘린더 앱을 직접 열지 않고 Discord에서 바로 일정을 등록/조회/수정/삭제하고 싶다는 요청. 별도 Anthropic API 키/결제 없이, **로그인된 Claude 구독 계정**을 그대로 쓸 수 있는지 확인했고 가능했다.

### 자연어 파싱 공통 방식
- 봇이 `claude -p --output-format json --tools "" --system-prompt "..." --json-schema "..."`를 자식 프로세스로 호출한다 (`src/eventParser.ts`의 `callClaudeJson`). `--tools ""`로 코드 실행 등 모든 도구를 꺼서, 순수 텍스트 구조화 추출만 하도록 제한했다.
- 오늘 날짜/타임존을 매번 system prompt에 넣어 "다음주 화요일", "내일" 같은 상대 표현을 정확히 계산하게 한다.
- 결과는 zod로 검증한다.
- `claude` CLI 호출 1회당 구독 사용량을 일부 소모한다 (요금제 한도 안에서는 추가 비용 없음).

### `/일정추가 내용:<자연어 문장>` — 등록
- 예: `다음주 화요일 2시 치과`. `parseEventText()`로 title/date/allDay/startTime/endTime/location을 뽑아 `calendar.createEvent()`로 바로 등록한다.
- 확인 절차 없이 즉시 등록하고, 등록된 내용을 Discord 응답으로 보여준다. 잘못 파싱됐으면 캘린더 앱에서 직접 고치면 된다 (이 프로젝트가 "캘린더가 항상 정답"인 구조이므로 일관성 유지).

### `/일정목록 기간:<자연어, 선택>` — 조회
- 기간 생략 시 오늘부터 7일. 입력하면 `parseSearchIntent()`로 날짜 범위를 뽑아 `calendar.listEvents()`로 조회, 날짜별로 묶어서 보여준다(`formatEventList`).

### `/일정수정 찾기:<자연어> 변경:<자연어>` — 수정
- `찾기` 텍스트를 `parseSearchIntent()`로 키워드+날짜범위로 바꿔 `calendar.listEvents(q=키워드)`로 후보를 찾는다 (`src/eventSearch.ts`의 `findMatchingEvents`). 날짜 언급이 없으면 오늘 기준 -7일~+60일에서 찾는다.
- 후보가 0개/2개 이상이면 등록하지 않고 안내만 한다(2개 이상이면 후보 목록을 보여주고 더 구체적으로 다시 요청하도록 유도).
- 정확히 1개면 `parseEventUpdate(기존 일정, 변경 텍스트)`로 "언급 안 된 필드는 기존 값 유지"한 최종 상태를 만들어 `calendar.updateEvent()`로 덮어쓴다.

### `/일정삭제 찾기:<자연어>` — 삭제
- 찾는 방식은 수정과 동일. 정확히 1개 후보를 찾으면 **삭제/취소 버튼**으로 확인받은 뒤에만 `calendar.deleteEvent()`를 호출한다 (되돌릴 수 없는 작업이라 등록/수정과 달리 확인 절차를 넣었다). 30초 안에 응답 없으면 자동 취소.

### 알아둘 점
- 시간이 자정을 넘어가는 종료 시각 계산(예: 23:30 + 1시간)은 다음날로 안 넘어가고 같은 날짜 안에서만 계산된다. 흔치 않은 경우라 우선 단순하게 두었다.
- 이 기능들은 이벤트 **쓰기**가 필요해서, Google OAuth 스코프를 `calendar.readonly` → `calendar.events`(이벤트 읽기/쓰기, 캘린더 자체 설정은 못 건드리는 최소 권한)로 바꿨다.
- **Claude 사용량 한도 초과 시 동작:** 자연어 명령어(`/일정추가` `/일정목록` `/일정수정` `/일정삭제`)만 영향을 받는다. 06:00 발송, 5분 폴링, 날씨, `/오늘일정`은 claude CLI를 쓰지 않아 그대로 동작한다. `eventParser.ts`의 `describeClaudeFailure()`가 Claude Code 공식 에러 문구("usage limit", "rate limit", "overloaded" 등)를 감지해서 원인을 바로 알 수 있는 한국어 메시지로 바꿔 Discord에 보여준다 (예: "Claude 사용량 한도에 도달해서 처리할 수 없습니다. 잠시 후 다시 시도하거나 캘린더 앱에서 직접 처리해주세요"). 봇 자체는 죽지 않는다.

## 1.6단계: 기상청 날씨 연동 (우산/빨래 안내)

### 배경
06시 발송 전에 오늘 날씨를 확인해서 우산이 필요한지, 빨래를 널어도 되는지 함께 안내받고 싶다는 요청.

### API: 기상청 API 허브 (data.go.kr 아님, 주의)
- 처음엔 공공데이터포털(data.go.kr) 방식(`serviceKey` 파라미터, `apis.data.go.kr` 도메인)으로 만들었다가, 사용자가 **기상청 API 허브**(apihub.kma.go.kr)로 키를 발급받아 `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`가 났다. 둘은 완전히 별개 시스템이다.
  - data.go.kr: `serviceKey` 파라미터, `https://apis.data.go.kr/1360000/...`
  - API 허브: `authKey` 파라미터, `https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getVilageFcst` — **최종적으로 이 방식을 사용한다.** 휴대전화 인증이 되어 있어야 키가 동작한다.
- 사용 API: 단기예보 조회서비스 `getVilageFcst`. 카테고리 중 POP(강수확률), PTY(강수형태), TMP(기온), TMN/TMX(최저/최고기온)만 쓴다.

### 위치: 격자 좌표(nx, ny) 계산
- 기상청은 5km 격자 좌표(nx, ny)로 위치를 받는다. 주소로는 못 받아서 위경도 → 격자 변환이 필요하다.
- **인천광역시 검단구 원당동** 기준: OpenStreetMap Nominatim으로 위경도(37.5924107, 126.6938209)를 구하고, 기상청 LCC 투영 변환 공식(RE=6371.00877, GRID=5.0, SLAT1=30°, SLAT2=60°, OLON=126°, OLAT=38°, XO=43, YO=136)으로 계산 → **nx=55, ny=127**.
- 다른 지역으로 이사하면 같은 방식(주소 → 위경도 → LCC 변환)으로 다시 계산하면 된다.

### 동작 방식
- `src/weather.ts`의 `getTodayWeather()`: 06시 발송 기준 05시 발표 단기예보를 조회한다 (발표 후 ~10분 뒤 조회 가능하므로 06시엔 이미 준비됨). 05시 발표분이 없으면 02시 발표분 → 전날 23시 발표분 순서로 재시도한다.
- 오늘 날짜의 시간대별 POP 중 최댓값, PTY가 하나라도 0이 아니면 `hasPrecipitation=true`로 기록.
- 판단 기준(둘 다 `.env`에서 조절 가능):
  - `UMBRELLA_POP_THRESHOLD`(기본 50%): 강수확률이 이 값 이상이거나 `hasPrecipitation`이면 우산 챙기라고 안내.
  - `LAUNDRY_POP_THRESHOLD`(기본 30%): 강수확률이 이 값 **미만이고** 강수 예보가 없어야 빨래 널어도 된다고 안내.
- 06시 발송 메시지 상단에 날씨 한 줄이 붙는다 (`formatDailySummary`가 `weather`를 선택 인자로 받아 처리). 캘린더 변경 시 재발송되는 업데이트 메시지(`formatUpdatedSummary`)에는 날씨를 다시 붙이지 않는다 (하루 중 날씨가 자주 바뀌지 않고, 원래 목적이 "06시 발송 전 확인"이었기 때문).
- 날씨 조회가 실패해도(키 문제, API 장애 등) **캘린더 발송 자체는 막지 않는다** — 로그만 남기고 날씨 없이 발송한다 (`scheduler.ts`의 `fetchWeatherSafely`).
- `/오늘날씨` 명령어로 언제든 즉시 조회 가능.

## 핵심 설계 결정

### 1. Discord: 봇 계정 (discord.js v14)
채널 웹훅과 봇 계정을 비교했다.

| | 채널 웹훅 | 봇 계정 (discord.js) |
|---|---|---|
| 설정 | 채널 설정에서 URL 복사 | 개발자 포털에서 앱·봇 생성, 토큰 발급, 서버 초대 |
| 메시지 수정 | 가능 | 가능 |
| DM 발송 | 불가 (서버 채널만) | 가능 |
| 명령어 (`/오늘일정`) | 불가 | 가능 |
| 상시 연결 | 필요 없음 | Gateway 웹소켓 연결 유지 |

→ **결정: 봇 계정.** DM과 `/오늘일정` 명령어를 쓰기 위해 웹훅보다 봇을 택했다.

- Discord Developer Portal에서 앱과 봇 생성, 토큰 발급, 내 서버에 초대 (`bot`, `applications.commands` scope, 최소 권한: 메시지 보내기/읽기/기록보기).
- 발송 대상은 `.env`의 `DISCORD_TARGET_TYPE`(`channel` | `dm`)과 `DISCORD_TARGET_ID`로 지정한다.
- 06:00 발송 시 메시지를 보내고 message id를 state에 저장한다. 이후 변경이 감지되면 그 메시지를 `edit()`한다.
- 슬래시 명령어 `/오늘일정`: 즉시 오늘 일정을 조회해 응답한다(ephemeral).
- 봇 프로세스는 `client.login()`으로 Gateway에 상시 연결한다.

### 2. 카카오톡 (2단계, 보류)
- 카카오 채널 챗봇(오픈빌더)은 사용자가 먼저 말을 걸어야 응답하는 방식이라 능동 발송에 맞지 않는다. 능동 발송에는 알림톡(비즈니스 인증 필요, 유료)이 필요하다.
- 대안으로 검토한 것: 봇 전용 카카오 계정을 만들어 내 계정과 친구를 맺고, 카카오 로그인 친구 API(`talk_message`, `friends` 동의)로 "친구에게 보내기"를 사용. 팀원 등록 방식이면 비즈 앱 검수 없이 개발 모드로 사용 가능. 무료지만 일일 발송 쿼터가 있고, 텍스트 템플릿은 200자 제한이라 긴 목록은 분할 발송해야 한다.
- 착수 시 최신 카카오 개발자 문서를 다시 확인하고 이 섹션을 갱신한다.

### 3. 변경 감지: 5분 폴링 + 해시 비교
- Calendar push(watch)는 공개 HTTPS 엔드포인트가 필요해 개인 Mac 환경에 맞지 않는다.
- 대신 5분마다 오늘 범위(00:00~24:00 Asia/Seoul)의 `events.list`를 조회하고, 정규화한 목록의 해시를 마지막 발송 해시와 비교한다.
- 해시가 다르면: Discord는 아침 메시지를 수정(신규 항목 🆕 표시, 하단에 `수정됨 HH:mm`), 카카오는(2단계) 오늘 일정 전체를 재발송.
- 06:00 발송이 그 날의 기준점이며, 그 이전 변경은 무시한다.
- 하루 약 288회 호출로 API 쿼터상 문제없다.

### 4. Mac 상시 실행
- launchd LaunchAgent(`KeepAlive`, `RunAtLoad`)로 등록해 로그인 시 자동 시작, 죽으면 재시작.
- 캐치업: 프로세스 시작 시 이미 06:00이 지났는데 오늘 발송 기록이 없으면 즉시 발송한다(Mac이 잠들어 있었던 경우 대비).
- 선택 사항: `sudo pmset repeat wakeorpoweron MTWRFSU 05:58:00`으로 06시 직전 깨우기.

## 프로젝트 구조
```
ScheduleAlertBot/
  plan.md
  package.json / tsconfig.json / .env.example / .gitignore
  src/
    index.ts                  # 진입점: 스케줄러 시작, 캐치업, Discord 로그인
    config.ts                 # .env 로드·검증 (zod)
    scheduler.ts              # 06:00 크론 + 5분 폴링 (croner, timezone=Asia/Seoul)
    calendar.ts               # googleapis OAuth 클라이언트, getTodayEvents()
    format.ts                 # 이벤트 -> 표시용 텍스트 (Discord embed / 카카오 200자 분할)
    state.ts                  # data/state.json 읽기/쓰기
    notifiers/
      types.ts                # Notifier 인터페이스: sendDaily(), sendUpdate()
      discord.ts              # discord.js 클라이언트: send / edit, /오늘일정 명령어
  scripts/
    auth-google.ts            # 로컬 루프백 OAuth, refresh token 저장
    register-commands.ts      # 슬래시 명령어 등록 (1회 실행)
    send-test.ts              # 수동 발송 테스트 (--dry-run 지원)
  launchd/com.hwp.schedulealertbot.plist
  data/                       # 토큰·상태 저장 (git 제외)
```
의존성: `googleapis`, `discord.js`, `croner`, `dotenv`, `zod`. 개발용: `typescript`, `tsx`, `@types/node`. HTTP는 Node 내장 `fetch` 사용.

## 메시지 형식 예시
```
📅 9/28(월) 오늘 일정 (3)
• 종일  휴가
• 10:00-11:00  팀 회의
• 14:00  치과 @강남
```
변경 시 하단에 `_(수정됨 14:32)_` 를 덧붙이고, 새로 추가된 항목 앞에 🆕를 붙인다.

## 구현 순서
1. ~~plan.md 작성~~
2. 프로젝트 초기화 (npm, TS, .gitignore, .env.example)
3. Google OAuth 스크립트 + `getTodayEvents()`. `send-test --dry-run`으로 콘솔 출력 확인
4. Discord 봇 발송·수정, `/오늘일정` 명령어
5. state 저장, 스케줄러(06:00 + 5분 폴링), 캐치업
6. launchd plist, 설치 방법 문서화 *(여기까지 1단계)*
7. (2단계) 카카오: 앱 설정, auth 스크립트, 친구 메시지 발송, 200자 분할

## 사용자가 직접 준비할 것
- Google Cloud 프로젝트: Calendar API 활성화, OAuth 클라이언트(데스크톱 앱) 생성, 본인을 테스트 사용자로 추가 → Client ID/Secret
- Discord: 애플리케이션+봇 생성, 토큰 발급, 서버 초대, 발송 대상(채널 ID 또는 내 유저 ID) 확보
- (2단계) 봇용 카카오 계정 생성 → 내 계정과 친구 맺기, Kakao Developers 앱 설정

## 검증 방법
- `npm run send-test -- --dry-run`: 오늘 일정이 포맷대로 콘솔에 출력되는지 확인
- `npm run send-test`: Discord로 실제 발송되는지 확인
- `/오늘일정` 명령어 응답 확인
- 폴링 테스트: 실행 중 캘린더에서 오늘 일정 추가·수정·삭제 → 5분 안에 Discord 메시지가 수정(🆕 표시)되는지 확인
- 캐치업 테스트: `data/state.json`의 날짜를 지우고 재시작 → 즉시 발송되는지 확인
- launchd: `launchctl load` 후 재부팅해도 자동 실행되는지 확인
