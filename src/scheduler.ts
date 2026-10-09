// 이 앱의 심장 역할을 하는 모듈. croner로 네 가지 정기 작업을 돌린다:
//   1) 매일 06:00 — 오늘 일정(+ 할 일, 날씨)을 처음 발송
//   2) 5분마다   — 06:00 발송 이후 일정이 바뀌었는지 확인하고, 바뀌었으면 메시지를 갱신
//   3) 매일 저녁(EVENING_SEND_TIME, 기본 21:00) — 내일 일정/할 일/날씨 미리보기 발송
//   4) 매주 일요일(WEEKLY_SEND_TIME, 기본 20:00) — 다음 주 일정/할 일 요약 발송
// 작업이 실패하면 로그만 남기지 않고 Discord로도 알린다(reportFailure).
// 그 외에 "앱이 06:00을 지나서 켜졌을 때" 발송을 놓치지 않도록 하는 캐치업 로직도 여기 있다.
import { stat } from "node:fs/promises";
import { Cron } from "croner";
import { loadConfig } from "./config.js";
import { formatTomorrowPreview, formatWeeklySummary } from "./format.js";
import {
  getTodayEvents,
  getTodayRange,
  getTodayTasks,
  getOverdueTasks,
  getTasksOnDate,
  listTasks,
  listEvents,
  dateRangeToISO,
  addDaysToDateKey,
  TOKEN_PATH,
  type TaskItem,
} from "./calendar.js";
import { hashEvents, loadState, saveState, type DailyState } from "./state.js";
import { discordNotifier } from "./notifiers/discord.js";
import type { Notifier } from "./notifiers/types.js";
import { getTodayWeather, getTomorrowWeather } from "./weather.js";
import type { WeatherSummary } from "./weather.js";

const notifiers: Notifier[] = [discordNotifier];
// 2단계에서 카카오 구현이 끝나면 notifiers.push(kakaoNotifier)로 추가한다.

/** 날씨 조회 실패는 발송 자체를 막지 않는다. 키가 없거나 API 오류면 날씨 없이 진행한다. */
async function fetchWeatherSafely(): Promise<WeatherSummary | undefined> {
  try {
    return await getTodayWeather();
  } catch (err) {
    console.warn("[weather] 조회 실패, 날씨 없이 발송합니다:", (err as Error).message);
    return undefined;
  }
}

/** 할 일 조회 실패(권한 미승인 등)도 발송을 막지 않는다. 할 일 없이 진행한다. */
async function fetchTasksSafely(): Promise<TaskItem[] | undefined> {
  try {
    return await getTodayTasks();
  } catch (err) {
    console.warn("[tasks] 조회 실패, 할 일 없이 발송합니다:", (err as Error).message);
    return undefined;
  }
}

/** 보조 정보(밀린 할 일, 내일 날씨 등) 조회 실패는 발송을 막지 않는다. 실패하면 undefined로 돌려 해당 부분만 생략한다. */
async function safely<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[${label}] 조회 실패, 해당 정보 없이 발송합니다:`, (err as Error).message);
    return undefined;
  }
}

/** 06:00 발송(또는 캐치업)을 실제로 수행한다: 오늘 일정+날씨를 가져와 모든 notifier로 보내고, 그 결과를 상태로 저장한다. */
async function runDailySend(): Promise<void> {
  const { dateKey } = getTodayRange();
  console.log(`[daily] ${dateKey} 오늘 일정 발송 시작`);

  const events = await getTodayEvents();
  const weather = await fetchWeatherSafely();
  const tasks = await fetchTasksSafely();
  const overdueTasks = await safely("overdue", () => getOverdueTasks());
  const summary = { dateKey, events, tasks, overdueTasks };
  const hash = hashEvents(events);

  let discordMessageId: string | undefined;
  for (const notifier of notifiers) {
    const result = await notifier.sendDaily(summary, weather);
    if (notifier === discordNotifier) discordMessageId = result.messageId;
  }

  const state: DailyState = {
    dateKey,
    lastHash: hash,
    eventIds: events.map((e) => e.id),
    discordMessageId,
    dailySent: true,
  };
  await saveState(state);
  console.log(`[daily] ${dateKey} 발송 완료 (${events.length}건)`);
}

/** 저녁 발송: 내일 일정 + 내일 마감 할 일 + 내일 날씨를 보낸다. 일회성이라 상태 저장/캐치업은 하지 않는다. */
async function runEveningPreview(): Promise<void> {
  const tomorrow = addDaysToDateKey(getTodayRange().dateKey, 1);
  console.log(`[evening] ${tomorrow} 내일 미리보기 발송 시작`);

  const { timeMin, timeMax } = dateRangeToISO(tomorrow, tomorrow);
  const events = await listEvents(timeMin, timeMax);
  const tasks = await safely("tasks", () => getTasksOnDate(tomorrow));

  // 내일 일정도 할 일도 없으면 날씨만 보내는 건 소음이라 발송하지 않는다.
  if (events.length === 0 && (tasks ?? []).length === 0) {
    console.log(`[evening] ${tomorrow} 일정/할 일이 없어 발송을 건너뜁니다`);
    return;
  }

  const weather = await safely("weather", () => getTomorrowWeather());

  const text = formatTomorrowPreview({ dateKey: tomorrow, events, tasks }, weather);
  for (const notifier of notifiers) {
    await notifier.sendText(text);
  }
  console.log(`[evening] ${tomorrow} 발송 완료 (${events.length}건)`);
}

/** 일요일 저녁 발송: 내일(월)부터 7일간의 일정과 마감 할 일을 요약해 보낸다. 둘 다 없으면 보내지 않는다. */
async function runWeeklySummary(): Promise<void> {
  const dateFrom = addDaysToDateKey(getTodayRange().dateKey, 1);
  const dateTo = addDaysToDateKey(dateFrom, 6);
  console.log(`[weekly] ${dateFrom}~${dateTo} 주간 요약 발송 시작`);

  const { timeMin, timeMax } = dateRangeToISO(dateFrom, dateTo);
  const events = await listEvents(timeMin, timeMax);
  const tasks = (await safely("tasks", () => listTasks({ dateFrom, dateTo }))) ?? [];

  if (events.length === 0 && tasks.length === 0) {
    console.log("[weekly] 다음 주 일정/할 일이 없어 발송을 건너뜁니다");
    return;
  }

  const text = formatWeeklySummary(dateFrom, dateTo, events, tasks);
  for (const notifier of notifiers) {
    await notifier.sendText(text);
  }
  console.log(`[weekly] 발송 완료 (일정 ${events.length}건, 할 일 ${tasks.length}건)`);
}

/**
 * Google 인증 오류가 나면 재로그인할 때까지 Google을 호출하는 작업(폴링, 정기 발송)을 멈춘다.
 * 값은 오류 시점의 토큰 파일 수정 시각이고, `npm run auth:google`로 파일이 바뀌면 자동으로 재개한다.
 * null이면 중단 상태가 아니다. 메모리에만 있으므로 재시작하면 초기화된다.
 */
let authPausedTokenMtime: number | null = null;

async function getTokenMtime(): Promise<number> {
  try {
    return (await stat(TOKEN_PATH)).mtimeMs;
  } catch {
    return 0;
  }
}

/** 중단 상태면 true. 토큰 파일이 갱신됐으면 중단을 풀고 놓친 오늘 발송을 보충한 뒤 false를 돌려준다. */
async function isAuthPaused(): Promise<boolean> {
  if (authPausedTokenMtime === null) return false;
  if ((await getTokenMtime()) === authPausedTokenMtime) return true;
  authPausedTokenMtime = null;
  console.log("[auth] 토큰 파일이 갱신되어 작업을 재개합니다");
  await catchUpIfNeeded().catch((err) => reportFailure("재개 후 캐치업 발송", err));
  return false;
}

/** Google 토큰 만료·철회 등 재로그인이 필요한 인증 오류인지 판별한다. 일시적 네트워크 오류는 해당하지 않는다. */
function isGoogleAuthError(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } };
  const code = e?.response?.data?.error ?? e?.message ?? "";
  return /invalid_grant|invalid_client|unauthorized_client|invalid_token/.test(String(code));
}

/** 같은 인증 오류 알림을 이 시간 안에는 다시 보내지 않는다. 5분 폴링이 매번 같은 알림을 보내 도배하는 것을 막는다. */
const AUTH_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let lastAuthAlertAt = 0;

/** 작업 실패를 로그에 남기고 Discord 등으로도 알린다. 알림 자체가 실패해도(Discord 장애 등) 다른 작업에 영향이 없도록 삼킨다. */
async function reportFailure(label: string, err: unknown): Promise<void> {
  console.error(`[${label}] 실패:`, err);

  let text: string;
  if (isGoogleAuthError(err)) {
    authPausedTokenMtime = await getTokenMtime();
    if (Date.now() - lastAuthAlertAt < AUTH_ALERT_COOLDOWN_MS) return;
    lastAuthAlertAt = Date.now();
    text =
      `🔑 Google 인증이 만료되었거나 취소되어 ${label}에 실패했습니다.\n` +
      "재로그인할 때까지 자동 발송과 변경 감지를 멈춥니다. 서버에서 `npm run auth:google`로 다시 로그인하면 자동으로 재개됩니다.";
  } else {
    text = `⚠️ ${label} 실패: ${(err as Error)?.message ?? err}`;
  }

  for (const notifier of notifiers) {
    try {
      await notifier.sendText(text);
    } catch (notifyErr) {
      console.error(`[${label}] 실패 알림도 보내지 못했습니다:`, notifyErr);
    }
  }
}

/** 변경 감지 폴링이 이 횟수만큼 연속 실패하면(5분 간격이라 약 15분) 한 번 알린다. 일시적 오류로 도배되지 않게 하기 위함. */
const POLL_FAILURE_ALERT_THRESHOLD = 3;

/** 5분마다 호출되는 폴링 함수. 오늘 일정을 다시 조회해 이전 해시와 비교하고, 달라졌으면만 갱신 발송한다. */
async function runPollCheck(): Promise<void> {
  const { dateKey } = getTodayRange();
  const state = await loadState();

  // 아직 오늘 06:00 발송 전이면(=state가 없거나 어제 날짜) 폴링은 아무것도 하지 않는다.
  if (!state || state.dateKey !== dateKey || !state.dailySent) {
    return;
  }

  const events = await getTodayEvents();
  const hash = hashEvents(events);
  if (hash === state.lastHash) return; // 변경 없음

  console.log(`[poll] ${dateKey} 일정 변경 감지, 업데이트 발송`);
  const summary = { dateKey, events };
  const previousEventIds = new Set(state.eventIds);

  let discordMessageId = state.discordMessageId;
  for (const notifier of notifiers) {
    const result = await notifier.sendUpdate(summary, previousEventIds, {
      messageId: notifier === discordNotifier ? state.discordMessageId : undefined,
    });
    if (notifier === discordNotifier) discordMessageId = result.messageId;
  }

  await saveState({
    dateKey,
    lastHash: hash,
    eventIds: events.map((e) => e.id),
    discordMessageId,
    dailySent: true,
  });
}

/** Mac이 잠들어 있다가 06:00을 넘겨서 켜진 경우 등, 오늘 발송을 놓쳤으면 즉시 발송한다. */
async function catchUpIfNeeded(): Promise<void> {
  const config = loadConfig();
  const now = new Date();
  const { dateKey } = getTodayRange(now);

  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: config.TIMEZONE, hour: "2-digit", hour12: false }).format(now),
  );
  if (hour < 6) return; // 아직 06:00 전이면 정규 스케줄이 처리한다.

  const state = await loadState();
  if (state && state.dateKey === dateKey && state.dailySent) return; // 이미 오늘 발송됨

  console.log("[catchup] 오늘 발송이 아직 안 되어 즉시 발송합니다");
  await runDailySend();
}

/** 인증 오류로 중단 중이면 건너뛴다. 정기 작업은 모두 이 함수를 거쳐 실행한다. */
async function guarded(fn: () => Promise<void>): Promise<void> {
  if (await isAuthPaused()) return;
  await fn();
}

export async function startScheduler(): Promise<void> {
  const config = loadConfig();

  // 캐치업 실패(Google 토큰 만료 등)로 프로세스가 죽으면 launchd 재시작 루프가 Discord 로그인 한도를 소진한다.
  // 그래서 실패를 알리기만 하고 스케줄러는 계속 시작한다.
  await catchUpIfNeeded().catch((err) => reportFailure("시작 시 캐치업 발송", err));

  // 매일 06:00
  new Cron("0 6 * * *", { timezone: config.TIMEZONE }, () => {
    guarded(runDailySend).catch((err) => reportFailure("아침 발송", err));
  });

  // 매일 저녁 EVENING_SEND_TIME(HH:MM)에 내일 미리보기
  const [eveningHour, eveningMinute] = config.EVENING_SEND_TIME.split(":").map(Number);
  new Cron(`${eveningMinute} ${eveningHour} * * *`, { timezone: config.TIMEZONE }, () => {
    guarded(runEveningPreview).catch((err) => reportFailure("저녁 미리보기", err));
  });

  // 매주 일요일 WEEKLY_SEND_TIME(HH:MM)에 다음 주 요약
  const [weeklyHour, weeklyMinute] = config.WEEKLY_SEND_TIME.split(":").map(Number);
  new Cron(`${weeklyMinute} ${weeklyHour} * * 0`, { timezone: config.TIMEZONE }, () => {
    guarded(runWeeklySummary).catch((err) => reportFailure("주간 요약", err));
  });

  // 5분마다 변경 감지 폴링
  let pollFailures = 0;
  new Cron("*/5 * * * *", { timezone: config.TIMEZONE }, () => {
    guarded(runPollCheck)
      .then(() => {
        pollFailures = 0;
      })
      .catch((err) => {
        pollFailures += 1;
        // 인증 오류는 재시도해도 낫지 않으므로 연속 실패를 기다리지 않고 바로 알린다(쿨다운은 reportFailure가 처리).
        if (isGoogleAuthError(err)) return reportFailure("일정 변경 감지", err);
        if (pollFailures === POLL_FAILURE_ALERT_THRESHOLD) return reportFailure("일정 변경 감지(연속 실패)", err);
        console.error("[poll] 실패:", err);
      });
  });

  console.log(
    `[scheduler] 시작됨 (timezone=${config.TIMEZONE}) — 매일 06:00 / ${config.EVENING_SEND_TIME} 발송, 일요일 ${config.WEEKLY_SEND_TIME} 주간 요약 + 5분마다 변경 감지`,
  );
}
