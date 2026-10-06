// 디스코드 슬래시 명령 사용 기록. 어떤 명령을 썼는지, 성공/실패/취소, 소요 시간을 로그 한 줄로 남긴다.
// 이 로그는 BotMng 관제 화면(게스트 공개)에 그대로 보이므로 사용자가 입력한 내용(일정 제목, 할 일 등)은 절대 남기지 않는다.
// 형식을 바꾸면 BotMng에서 `[command]` 태그로 필터링하는 쪽도 영향을 받는다.

export type Outcome = "success" | "failure" | "cancelled";

export interface CommandRecord {
  command: string; // 예: "/일정추가", "/비서(일정추가)"
  outcome: Outcome;
  ms: number;
  reason?: string;
}

interface Trace {
  action?: string;
  outcome: Outcome;
  reason?: string;
}

const LABEL: Record<Outcome, string> = { success: "성공", failure: "실패", cancelled: "취소" };
const MAX_REASON = 120;

export function formatCommandLine(r: CommandRecord): string {
  return `[command] ${r.command} ${LABEL[r.outcome]} (${r.ms}ms)${r.reason ? `: ${r.reason}` : ""}`;
}

/** 우리 코드가 정한 사유 문자열(예: "대상을 찾지 못함")을 한 줄·120자 이하로 줄인다. 오류 객체는 classifyError 로 처리한다. */
export function sanitizeReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_REASON ? `${oneLine.slice(0, MAX_REASON)}…` : oneLine;
}

/**
 * 오류를 분류한 이름으로 바꾼다. 오류 메시지는 로컬 경로(인증 토큰 위치)나 모델이 되풀이한 사용자 문장을 담을 수 있는데
 * 이 로그는 관제 화면에서 게스트에게도 보이므로, 메시지를 그대로 남기지 않고 종류만 남긴다.
 */
export function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return "알 수 없는 오류";
  const msg = err.message;
  const status = (err as { code?: unknown; status?: unknown }).code ?? (err as { status?: unknown }).status;

  if (/usage limit|사용량 한도|spend limit|credit balance|크레딧/i.test(msg)) return "Claude 한도 문제";
  if (/rate limit|\b429\b|요청이 몰려/i.test(msg)) return "요청 제한(rate limit)";
  if (/overloaded|과부하|\b529\b|high demand/i.test(msg)) return "Claude 과부하";
  if (/Google 인증|invalid_grant/i.test(msg) || status === 401) return "Google 인증 문제";
  if (typeof status === "number" && status >= 400 && status <= 599) return `Google API 오류(${status})`;
  if (/기상청/.test(msg)) return "기상청 API 오류";
  if (/자연어 처리|해석/.test(msg)) return "문장 해석 실패";
  return `내부 오류(${err.name})`;
}

// 핸들러들이 각자 오류를 잡아 답장만 하고 끝내므로, 결과는 핸들러가 직접 알려주도록 interaction 별로 모아 둔다.
const traces = new WeakMap<object, Trace>();
const traceOf = (i: object): Trace => {
  let t = traces.get(i);
  if (!t) traces.set(i, (t = { outcome: "success" }));
  return t;
};

/** `/비서`가 자유 문장을 해석한 동작(예: 일정추가). 문장 내용이 아니라 동작 이름만 받는다. */
export const noteAction = (i: object, action: string) => void (traceOf(i).action = action);

/** 명령이 실패했음을 알린다. 사유가 문자열이면 그대로(우리 코드가 정한 값), 오류 객체면 분류한 이름만 남긴다. 이미 실패로 기록됐다면 첫 사유를 유지한다. */
export function noteFailure(i: object, reason: unknown) {
  const t = traceOf(i);
  if (t.outcome === "failure") return;
  t.outcome = "failure";
  t.reason = typeof reason === "string" ? sanitizeReason(reason) : classifyError(reason);
}

/** 사용자가 취소했거나 시간이 초과된 경우. 실패로 이미 기록됐다면 덮어쓰지 않는다. */
export function noteCancelled(i: object, reason: string) {
  const t = traceOf(i);
  if (t.outcome === "failure") return;
  t.outcome = "cancelled";
  t.reason = reason;
}

/** 명령 핸들러를 실행하고 결과를 로그 한 줄로 남긴다. 핸들러가 예외를 던지면 실패로 기록하고 그대로 다시 던진다. */
export async function runLogged(interaction: { commandName: string }, handler: () => Promise<unknown>, now: () => number = Date.now) {
  const started = now();
  let thrown: unknown;
  let didThrow = false;
  try {
    await handler();
  } catch (err) {
    didThrow = true;
    thrown = err;
    noteFailure(interaction, err);
  }

  const t = traceOf(interaction);
  const name = `/${interaction.commandName}`;
  const line = formatCommandLine({ command: t.action ? `${name}(${t.action})` : name, outcome: t.outcome, ms: now() - started, reason: t.reason });
  if (t.outcome === "failure") console.warn(line);
  else console.log(line);

  if (didThrow) throw thrown;
}
