// 수동 발송 테스트용 스크립트. `--dry-run`이면 콘솔에만 출력하고,
// 없으면 실제로 Discord에 발송해서 봇 설정이 제대로 됐는지 확인할 수 있다.
import { loadConfig } from "../src/config.js";
import { getTodayEvents, getTodayRange } from "../src/calendar.js";
import { formatDailySummary } from "../src/format.js";
import { startDiscordClient, discordNotifier } from "../src/notifiers/discord.js";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  loadConfig();
  const events = await getTodayEvents();
  const { dateKey } = getTodayRange();
  const summary = { dateKey, events };
  const text = formatDailySummary(summary);

  console.log("----- 발송될 내용 -----");
  console.log(text);
  console.log("----------------------");

  if (dryRun) {
    console.log("(--dry-run 모드: 실제로 발송하지 않았습니다)");
    return;
  }

  await startDiscordClient();
  const result = await discordNotifier.sendDaily(summary);
  console.log(`Discord로 발송 완료 (messageId=${result.messageId})`);
  process.exit(0);
}

main().catch((err) => {
  console.error("실패:", err);
  process.exit(1);
});
