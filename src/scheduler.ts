// 이 앱의 심장 역할을 하는 모듈. croner로 세 가지 정기 작업을 돌린다:
//   1) 매일 06:00 — 오늘 일정(+ 할 일, 날씨)을 처음 발송
//   2) 5분마다   — 06:00 발송 이후 일정이 바뀌었는지 확인하고, 바뀌었으면 메시지를 갱신
//   3) 매일 저녁(EVENING_SEND_TIME, 기본 21:00) — 내일 일정/할 일/날씨 미리보기 발송
// 그 외에 "앱이 06:00을 지나서 켜졌을 때" 발송을 놓치지 않도록 하는 캐치업 로직도 여기 있다.
import { Cron } from "croner";
import { loadConfig } from "./config.js";
import { formatTomorrowPreview } from "./format.js";
import {
  getTodayEvents,
  getTodayRange,
  getTodayTasks,
  getOverdueTasks,
  getTasksOnDate,
  listEvents,
  dateRangeToISO,
  addDaysToDateKey,
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
  const weather = await safely("weather", () => getTomorrowWeather());

  const text = formatTomorrowPreview({ dateKey: tomorrow, events, tasks }, weather);
  for (const notifier of notifiers) {
    await notifier.sendText(text);
  }
  console.log(`[evening] ${tomorrow} 발송 완료 (${events.length}건)`);
}

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

export async function startScheduler(): Promise<void> {
  const config = loadConfig();

  await catchUpIfNeeded();

  // 매일 06:00
  new Cron("0 6 * * *", { timezone: config.TIMEZONE }, () => {
    runDailySend().catch((err) => console.error("[daily] 실패:", err));
  });

  // 매일 저녁 EVENING_SEND_TIME(HH:MM)에 내일 미리보기
  const [eveningHour, eveningMinute] = config.EVENING_SEND_TIME.split(":").map(Number);
  new Cron(`${eveningMinute} ${eveningHour} * * *`, { timezone: config.TIMEZONE }, () => {
    runEveningPreview().catch((err) => console.error("[evening] 실패:", err));
  });

  // 5분마다 변경 감지 폴링
  new Cron("*/5 * * * *", { timezone: config.TIMEZONE }, () => {
    runPollCheck().catch((err) => console.error("[poll] 실패:", err));
  });

  console.log(`[scheduler] 시작됨 (timezone=${config.TIMEZONE}) — 매일 06:00 / ${config.EVENING_SEND_TIME} 발송 + 5분마다 변경 감지`);
}
