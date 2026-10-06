import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { classifyError, formatCommandLine, noteAction, noteCancelled, noteFailure, runLogged, sanitizeReason, timeWait } from "./commandLog.js";

// console.log / console.warn 출력을 가로챈다.
const out: { level: "log" | "warn"; line: string }[] = [];
const original = { log: console.log, warn: console.warn };
beforeEach(() => {
  out.length = 0;
  console.log = (...a: unknown[]) => void out.push({ level: "log", line: a.join(" ") });
  console.warn = (...a: unknown[]) => void out.push({ level: "warn", line: a.join(" ") });
});
afterEach(() => {
  console.log = original.log;
  console.warn = original.warn;
});

const fake = (commandName: string) => ({ commandName, options: { getString: () => "내일 3시 치과 비밀내용" } });
const tick = (ms: number) => { let t = 1000; return () => ((t += ms), t - ms); }; // 호출마다 시각이 ms 만큼 흐르는 시계

test("formatCommandLine: 성공/실패/취소 형식", () => {
  assert.equal(formatCommandLine({ command: "/오늘일정", outcome: "success", ms: 1243 }), "[command] /오늘일정 성공 (1243ms)");
  assert.equal(formatCommandLine({ command: "/일정추가", outcome: "failure", ms: 80, reason: "Google API 오류" }), "[command] /일정추가 실패 (80ms): Google API 오류");
  assert.equal(formatCommandLine({ command: "/일정삭제", outcome: "cancelled", ms: 30000, reason: "시간 초과" }), "[command] /일정삭제 취소 (30000ms): 시간 초과");
});

test("sanitizeReason: 우리 코드가 정한 문자열 사유를 한 줄·120자 이하로", () => {
  assert.equal(sanitizeReason("가\n나\r\n다"), "가 나 다");
  assert.equal(sanitizeReason("대상을 찾지 못함"), "대상을 찾지 못함");
  const long = sanitizeReason("가".repeat(300));
  assert.equal(long.length, 121);
  assert.ok(long.endsWith("…"));
});

test("classifyError: 오류 메시지를 그대로 쓰지 않고 분류한 이름만 돌려준다", () => {
  assert.equal(classifyError(new Error("Claude 사용량 한도에 도달해서 자연어 명령을 처리할 수 없습니다.")), "Claude 한도 문제");
  assert.equal(classifyError(new Error("요청이 몰려 일시적으로 제한됐습니다(rate limit).")), "요청 제한(rate limit)");
  assert.equal(classifyError(new Error("Claude 서버가 일시적으로 과부하 상태입니다.")), "Claude 과부하");
  assert.equal(classifyError(new Error("기상청 API 오류(20261006 0500): HTTP 500")), "기상청 API 오류");
  assert.equal(classifyError(new Error("자연어 처리에 실패했습니다: 알 수 없는 응답")), "문장 해석 실패");
  assert.equal(classifyError(Object.assign(new Error("Forbidden"), { code: 403 })), "Google API 오류(403)");
  assert.equal(classifyError(new TypeError("undefined is not a function")), "내부 오류(TypeError)");
  assert.equal(classifyError(new Error("뭔가 이상함")), "내부 오류(Error)");
  assert.equal(classifyError("문자열 오류"), "알 수 없는 오류");
});

test("classifyError: 로컬 경로와 사용자 입력은 분류 결과에 나오지 않는다 (로그가 게스트에게 공개되므로)", () => {
  const pathLeak = classifyError(new Error("Google 인증 토큰이 없습니다. 먼저 로그인하세요. (찾는 경로: /Users/someone/secret/token.json)"));
  assert.equal(pathLeak, "Google 인증 문제");
  assert.ok(!pathLeak.includes("/Users"));
  const echoed = classifyError(new Error("자연어 처리에 실패했습니다: '내일 3시 치과 비밀내용'을 해석할 수 없음"));
  assert.ok(!echoed.includes("치과") && !echoed.includes("비밀내용"));
  const unknown = classifyError(new Error("내일 3시 치과 비밀내용 때문에 터짐"));
  assert.ok(!unknown.includes("치과"));
});

test("runLogged: 정상 종료는 성공(INFO), 소요 시간 포함", async () => {
  await runLogged(fake("오늘일정"), async () => {}, tick(250));
  assert.deepEqual(out, [{ level: "log", line: "[command] /오늘일정 성공 (250ms)" }]);
});

test("runLogged: noteFailure 가 불리면 실패(WARN)", async () => {
  const i = fake("일정추가");
  await runLogged(i, async () => noteFailure(i, new Error("날짜를 해석하지 못했습니다")), tick(10));
  assert.deepEqual(out, [{ level: "warn", line: "[command] /일정추가 실패 (10ms): 문장 해석 실패" }]);
});

test("runLogged: 핸들러가 예외를 던지면 실패로 기록하고 그대로 다시 던진다", async () => {
  await assert.rejects(() => runLogged(fake("오늘날씨"), async () => { throw new Error("기상청 오류"); }, tick(5)), /기상청 오류/); // 호출한 쪽에는 원래 오류가 그대로 전달된다
  assert.deepEqual(out, [{ level: "warn", line: "[command] /오늘날씨 실패 (5ms): 기상청 API 오류" }]);
});

test("runLogged: /비서는 해석된 동작을 같이 남긴다", async () => {
  const i = fake("비서");
  await runLogged(i, async () => noteAction(i, "일정추가"), tick(7));
  assert.deepEqual(out, [{ level: "log", line: "[command] /비서(일정추가) 성공 (7ms)" }]);
});

test("runLogged: 취소는 INFO로, 실패가 이미 기록됐다면 취소로 덮어쓰지 않는다", async () => {
  const a = fake("일정삭제");
  await runLogged(a, async () => noteCancelled(a, "사용자가 취소"), tick(1));
  assert.deepEqual(out.pop(), { level: "log", line: "[command] /일정삭제 취소 (1ms): 사용자가 취소" });
  const b = fake("일정수정");
  await runLogged(b, async () => { noteFailure(b, "대상을 찾지 못함"); noteCancelled(b, "시간 초과"); }, tick(1));
  assert.deepEqual(out.pop(), { level: "warn", line: "[command] /일정수정 실패 (1ms): 대상을 찾지 못함" });
});

test("사용자가 입력한 내용은 어떤 경우에도 로그에 나오지 않는다 (게스트에게 로그가 공개되므로)", async () => {
  const ok = fake("일정추가");
  await runLogged(ok, async () => {}, tick(1));
  const bad = fake("일정추가");
  await runLogged(bad, async () => noteFailure(bad, new Error("내일 3시 치과 비밀내용 등록 실패")), tick(1));
  const crash = fake("비서");
  await assert.rejects(() => runLogged(crash, async () => { throw new Error("x"); }, tick(1)));
  assert.equal(out.length, 3);
  for (const o of out) assert.ok(!o.line.includes("비밀내용") && !o.line.includes("치과"), o.line);
});

test("timeWait: 확인 버튼을 기다린 시간은 처리 시간에서 뺀다", async () => {
  // 시계는 호출할 때마다 100ms 씩 흐른다: 시작(1000) → 대기 시작(1100) → 대기 끝(1200) → 종료(1300). 전체 300ms 중 대기 100ms.
  const now = tick(100);
  const i = fake("일정삭제");
  await runLogged(i, async () => { await timeWait(i, Promise.resolve("버튼"), now); }, now);
  assert.deepEqual(out, [{ level: "log", line: "[command] /일정삭제 성공 (200ms)" }]);
});

test("timeWait: 대기가 시간 초과(예외)로 끝나도 기다린 시간은 뺀다", async () => {
  const now = tick(100);
  const i = fake("일정수정");
  await runLogged(i, async () => {
    try { await timeWait(i, Promise.reject(new Error("timeout")), now); } catch { noteCancelled(i, "시간 초과"); }
  }, now);
  assert.deepEqual(out, [{ level: "log", line: "[command] /일정수정 취소 (200ms): 시간 초과" }]);
});

test("timeWait: 여러 번 기다리면 모두 합쳐서 뺀다", async () => {
  const now = tick(100); // 시작(1000) 대기1(1100~1200) 대기2(1300~1400) 종료(1500) = 전체 500, 대기 200
  const i = fake("일정수정");
  await runLogged(i, async () => { await timeWait(i, Promise.resolve(), now); await timeWait(i, Promise.resolve(), now); }, now);
  assert.deepEqual(out, [{ level: "log", line: "[command] /일정수정 성공 (300ms)" }]);
});

test("timeWait 를 쓰지 않으면 전체 시간 그대로", async () => {
  await runLogged(fake("오늘일정"), async () => {}, tick(250));
  assert.deepEqual(out, [{ level: "log", line: "[command] /오늘일정 성공 (250ms)" }]);
});
