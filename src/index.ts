// 앱 진입점. launchd(또는 `npm run dev`/`start`)가 이 파일 하나만 실행하면
// 1) 환경변수 검증 → 2) Discord 봇 로그인 → 3) 06:00 발송 + 5분 폴링 스케줄러 시작 순서로 상시 구동된다.
import { loadConfig } from "./config.js";
import { startDiscordClient } from "./notifiers/discord.js";
import { startScheduler } from "./scheduler.js";

async function main() {
  loadConfig(); // .env 값이 잘못됐으면 여기서 바로 에러를 던지고 종료한다.
  await startDiscordClient();
  console.log("[discord] 로그인 완료");
  await startScheduler(); // 내부에서 캐치업 발송 여부도 확인한다.
}

main().catch((err) => {
  // 여기서 잡히는 에러는 초기화 단계의 치명적 오류(설정 누락, 로그인 실패 등)이므로 프로세스를 종료한다.
  // launchd의 KeepAlive가 이후 자동으로 재시작을 시도한다.
  console.error("치명적 오류로 종료합니다:", err);
  process.exit(1);
});
