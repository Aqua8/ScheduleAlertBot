// console 출력 앞에 "한국시간(ISO, +09:00) 레벨"을 붙인다. 관제 서비스(BotMng)가 out.log/error.log를 파싱할 때 쓰는 형식이므로
// 형식을 바꾸면 BotMng의 파서도 같이 바꿔야 한다. 예) 2026-10-06T15:00:00.000+09:00 INFO [daily] 발송 완료 (1건)
const levels = { log: "INFO", info: "INFO", warn: "WARN", error: "ERROR" } as const;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // 한국은 서머타임이 없어 고정 오프셋으로 충분하다.

const kstNow = () => new Date(Date.now() + KST_OFFSET_MS).toISOString().replace("Z", "+09:00");

for (const [method, level] of Object.entries(levels)) {
  const original = console[method as keyof typeof levels].bind(console);
  console[method as keyof typeof levels] = (...args: unknown[]) => original(`${kstNow()} ${level}`, ...args);
}
