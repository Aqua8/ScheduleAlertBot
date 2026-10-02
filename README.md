# 📅 ScheduleAlertBot

Google Calendar 일정을 매일 아침 자동으로 요약해서 **Discord**로 보내주고, 일정이 바뀌면 실시간으로 메시지를 수정해주는 개인용 비서 봇입니다. 자연어 명령어로 캘린더 일정을 추가·조회·수정·삭제할 수 있고, 아침 발송 전에는 **기상청 날씨**를 함께 확인해서 우산과 빨래 여부까지 알려줍니다.

> 설계 배경, 의사결정 과정, 상세 스펙은 [`plan.md`](./plan.md)에 정리되어 있습니다.

## ✨ 주요 기능

- **매일 아침 자동 발송** — 06:00(Asia/Seoul)에 오늘 일정 전체를 Discord로 발송
- **저녁 내일 미리보기** — 매일 21:00(`EVENING_SEND_TIME`으로 변경 가능)에 내일 일정·마감 할 일·날씨를 발송
- **할 일 연동** — Google Tasks의 오늘 마감 할 일과 마감이 지난 밀린 할 일을 아침 메시지에 함께 표시
- **실시간 변경 감지** — 5분마다 폴링해서 일정이 추가/수정/삭제되면 아침 메시지를 자동으로 수정(🆕 표시)
- **날씨 안내** — 기상청 단기예보로 강수확률·기온, 비/눈 오는 시간대를 확인해 우산/빨래 여부를 판단
- **자연어 캘린더·할 일 관리** — Discord 슬래시 명령어에 자연어 문장을 입력하면 일정(반복 일정 포함)과 할 일을 등록/조회/수정/삭제/완료
- **안전장치** — 검색 결과가 여러 개면 되묻고, 삭제처럼 되돌릴 수 없는 작업은 버튼으로 한 번 더 확인
- **상시 구동** — macOS `launchd`로 등록해 재부팅 후에도 자동 실행, 다운타임 이후엔 캐치업 발송

## 🛠 사용 기술 (Tech Stack)

| 영역 | 기술 |
|---|---|
| 언어 / 런타임 | **TypeScript**, **Node.js 24** (ESM), [`tsx`](https://github.com/privatenumber/tsx) |
| 메신저 연동 | **Discord.js v14** — 봇 로그인, 슬래시 커맨드, 메시지 수정, 버튼 컴포넌트 |
| 외부 API 연동 | **Google Calendar API** (OAuth 2.0, `googleapis`), **기상청 API 허브**(단기예보 조회서비스) |
| 자연어 처리 | **Claude Code CLI**를 비대화형(`-p`, `--json-schema`)으로 호출해 자연어 → 구조화 JSON 변환 (별도 API 키 없이 Claude 구독 계정 활용) |
| 스케줄링 | [`croner`](https://github.com/hexagon/croner) — cron 표현식 기반 작업 스케줄러 |
| 검증 / 설정 | [`zod`](https://github.com/colinhacks/zod) 기반 환경변수 스키마 검증 |
| 배포 / 운영 | macOS **launchd** (LaunchAgent), 파일 기반 상태 저장(`data/state.json`) |
| 아키텍처 패턴 | `Notifier` 인터페이스로 메신저(Discord/카카오톡)를 추상화해 2단계 확장 대비 |

## ⚙️ 동작 방식

```
06:00 ──▶ Google Calendar·Tasks 조회 ──▶ 기상청 날씨 조회 ──▶ Discord 발송
                                                              │
                                                  이후 5분마다 폴링
                                                              │
                                              변경 감지 시 메시지 수정 (🆕 표시)
```

- Google Calendar push(webhook) 대신 **5분 폴링 + 해시 비교** 방식을 써서, 별도 공개 서버 없이 개인 Mac에서도 동작하도록 설계했습니다.
- 날씨·할 일 조회가 실패해도 일정 발송 자체는 막지 않습니다 (로그만 남기고 해당 정보 없이 발송).
- 저녁 내일 미리보기는 일회성 발송이라 변경 감지나 캐치업 대상이 아닙니다 (Mac이 그 시각에 꺼져 있으면 그날은 건너뜁니다).
- Mac이 06:00에 꺼져 있었다면, 다음 실행 시 즉시 발송하는 캐치업 로직이 있습니다.

## 💬 Discord 명령어

| 명령어 | 설명 | 예시 |
|---|---|---|
| `/오늘일정` | 오늘 일정을 즉시 조회 | — |
| `/일정추가 내용:<문장>` | 자연어로 일정 등록 | `다음주 화요일 2시 치과` |
| `/일정목록 기간:<문장, 선택>` | 기간 내 일정 조회 (기본: 오늘부터 7일) | `이번주` |
| `/일정수정 찾기:<문장> 변경:<문장>` | 기존 일정을 찾아 수정 | 찾기=`내일 치과`, 변경=`3시로 변경` |
| `/일정삭제 찾기:<문장>` | 기존 일정을 찾아 삭제 (확인 버튼 필요) | `내일 치과` |
| `/오늘날씨` | 오늘 날씨 + 우산/빨래 여부 조회 | — |
| `/할일추가 내용:<문장>` | 자연어로 할 일 등록 (마감일은 선택) | `내일까지 보고서 제출` |
| `/할일수정 찾기:<문장> 변경:<문장>` | 기존 할 일을 찾아 수정 | 찾기=`보고서`, 변경=`금요일로 변경` |
| `/할일삭제 찾기:<문장>` | 기존 할 일을 찾아 삭제 (확인 버튼 필요) | `보고서` |
| `/할일완료 찾기:<문장>` | 기존 할 일을 찾아 완료 처리 | `보고서` |

`/일정추가`는 `매주 화요일 저녁 7시 운동`, `격주 금요일 3시 스터디 10번`처럼 반복 표현도 이해합니다. 반복 일정을 수정/삭제할 때는 "이번 회차만 / 전체 반복"을 버튼으로 고릅니다. (반복 일정은 같은 이름의 회차가 여러 개라 `/일정수정`·`/일정삭제`의 찾기에 날짜를 함께 적어야 합니다. 예: `10/6 운동`)

자연어 해석은 로컬에 로그인된 `claude` CLI를 호출해 처리하므로, 이 기능들을 쓰려면 봇을 실행하는 머신에 [Claude Code](https://claude.com/claude-code)가 설치·로그인되어 있어야 합니다.

## 📂 프로젝트 구조

```
ScheduleAlertBot/
├── src/
│   ├── index.ts            # 진입점 — Discord 로그인, 스케줄러 시작
│   ├── config.ts           # 환경변수 로드 및 zod 검증
│   ├── calendar.ts         # Google Calendar OAuth + CRUD (조회/등록/수정/삭제)
│   ├── weather.ts          # 기상청 단기예보 조회, 우산/빨래 판단
│   ├── eventParser.ts      # claude CLI 호출 — 자연어 → 구조화 JSON
│   ├── eventSearch.ts      # 자연어 설명으로 기존 일정 검색
│   ├── format.ts           # Discord 메시지 포맷팅
│   ├── state.ts            # 발송 상태 저장 (변경 감지용 해시 등)
│   ├── scheduler.ts        # 06:00 발송 + 5분 폴링 크론 작업
│   └── notifiers/
│       ├── types.ts        # Notifier 인터페이스 (메신저 추상화)
│       └── discord.ts      # Discord 봇 구현 (슬래시 명령어 전체)
├── scripts/
│   ├── auth-google.ts      # Google OAuth 최초 로그인
│   ├── register-commands.ts# 슬래시 명령어 등록
│   └── send-test.ts        # 수동 발송 테스트
├── launchd/                # macOS 상시 실행용 plist
└── plan.md                 # 설계 문서 (의사결정 배경 포함)
```

## 🚀 시작하기

### 1. 준비물

<details>
<summary><b>Google Cloud (Calendar API)</b></summary>

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. "API 및 서비스 > 라이브러리"에서 **Google Calendar API** 활성화
3. "API 및 서비스 > OAuth 동의 화면"에서 User Type을 **외부**로 설정, 테스트 사용자로 본인 Google 계정 추가
4. "사용자 인증 정보 > OAuth 클라이언트 ID" → 애플리케이션 유형 **데스크톱 앱**으로 생성
5. 발급된 **클라이언트 ID / 클라이언트 보안 비밀번호**를 `.env`에 입력

</details>

<details>
<summary><b>Discord 봇</b></summary>

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. "Bot" 탭에서 봇 생성 후 토큰 발급 (한 번만 보여주니 즉시 복사)
3. "OAuth2 > URL Generator"에서 scope: `bot`, `applications.commands` / 권한: `Send Messages`, `Read Message History`, `View Channel` 체크 → 생성된 URL로 내 서버에 초대
4. `.env`에 `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`(General Information의 Application ID) 입력
5. 발송 대상 결정
   - 서버 채널로 받기: `DISCORD_TARGET_TYPE=channel`, `DISCORD_TARGET_ID`는 채널 ID
   - 내 DM으로 받기: `DISCORD_TARGET_TYPE=dm`, `DISCORD_TARGET_ID`는 내 유저 ID

</details>

<details>
<summary><b>기상청 날씨 (API 허브)</b></summary>

1. [기상청 API 허브](https://apihub.kma.go.kr) 가입 (공공데이터포털 data.go.kr과는 다른 별개 시스템) — 휴대전화 인증 필요
2. **단기예보 조회서비스 (VilageFcstInfoService_2.0)** 활용신청 → 발급된 **인증키(authKey)**를 `.env`의 `KMA_SERVICE_KEY`에 입력
3. `.env`의 `WEATHER_NX`, `WEATHER_NY`를 거주 지역의 기상청 5km 격자 좌표로 설정
4. (선택) `UMBRELLA_POP_THRESHOLD`, `LAUNDRY_POP_THRESHOLD`로 판단 기준 강수확률 조절

</details>

### 2. 설치 및 초기 설정

```bash
npm install
cp .env.example .env       # 값 채워넣기
npm run auth:google        # 브라우저에서 Google 로그인 → data/google-token.json 생성
npm run register-commands  # 슬래시 명령어 등록 (1회, 반영까지 최대 1시간)
```

### 3. 테스트

```bash
npm run send-test -- --dry-run   # 콘솔에만 출력, 실제 발송 안 함
npm run send-test                # Discord로 실제 발송
```

### 4. 개발 중 실행

```bash
npm run dev   # tsx watch로 실행, 파일 변경 시 자동 재시작
```

### 5. Mac에 상시 서비스로 등록 (launchd)

```bash
# launchd/com.hwp.schedulealertbot.plist 안의 node 경로를 `which node` 결과로 먼저 맞춰주세요
cp launchd/com.hwp.schedulealertbot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.hwp.schedulealertbot.plist
```

- 로그: `data/out.log`, `data/error.log`
- 중지: `launchctl unload ~/Library/LaunchAgents/com.hwp.schedulealertbot.plist`
- (선택) 06시 직전 Mac을 깨우기: `sudo pmset repeat wakeorpoweron MTWRFSU 05:58:00`

## 🗺 로드맵

- [x] Google Calendar ↔ Discord 연동 (발송/수정/캐치업)
- [x] 자연어 명령어로 캘린더 CRUD
- [x] 기상청 날씨 연동 (우산/빨래 안내)
- [ ] 카카오톡 연동 (2단계 — 자세한 내용은 [`plan.md`](./plan.md) 참고)

## 📄 라이선스

개인 프로젝트로 제작되었습니다.
