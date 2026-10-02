// `/빈시간`이 "언제 비어 있는지"를 계산하는 모듈. 하루 중 탐색 시간대(기본 09:00~18:00) 안에서
// 일정이 없는 구간을 찾는다. 종일 일정은 시간을 막지 않는 것으로 보고 제외한다(기념일 등이 많아서).
import { listEvents, dateRangeToISO, dateKeyToUtcMs, addDaysToDateKey } from "./calendar.js";
import type { CalendarEvent } from "./calendar.js";
import { loadConfig } from "./config.js";

const WINDOW_START_MINUTE = 9 * 60;
const WINDOW_END_MINUTE = 18 * 60;
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** "09:00~18:00" 형태의 탐색 시간대 표시용 문자열 */
export const FREE_TIME_WINDOW_LABEL = `${hhmm(WINDOW_START_MINUTE)}~${hhmm(WINDOW_END_MINUTE)}`;
/** 한 번에 조회할 수 있는 최대 기간(일). listEvents가 최대 50건까지만 가져오므로 너무 길면 빈 시간이 부정확해진다. */
export const MAX_FREE_TIME_DAYS = 14;

export interface FreeSlot {
  dateKey: string;
  /** "HH:MM" */
  start: string;
  end: string;
}

/**
 * 하루치 빈 구간을 계산한다. dayStartMs는 그날 00:00의 UTC 밀리초, notBeforeMs를 주면 그 시각 이전은 막힌 것으로 본다(오늘의 지난 시간).
 * 순수 함수라 캘린더 호출 없이 테스트할 수 있다.
 */
export function computeFreeSlots(
  dateKey: string,
  dayStartMs: number,
  events: Pick<CalendarEvent, "allDay" | "start" | "end">[],
  minMinutes: number,
  notBeforeMs?: number,
): FreeSlot[] {
  // 탐색 시간대 안으로 잘라낸 "막힌 구간"(분 단위, 그날 00:00 기준)
  const busy: [number, number][] = [];
  const clip = (startMs: number, endMs: number) => {
    const s = Math.max((startMs - dayStartMs) / 60_000, WINDOW_START_MINUTE);
    const e = Math.min((endMs - dayStartMs) / 60_000, WINDOW_END_MINUTE);
    if (e > s) busy.push([s, e]);
  };

  for (const ev of events) {
    if (!ev.allDay) clip(new Date(ev.start).getTime(), new Date(ev.end).getTime());
  }
  if (notBeforeMs !== undefined) clip(dayStartMs, notBeforeMs);

  busy.sort((a, b) => a[0] - b[0]);
  const slots: FreeSlot[] = [];
  let cursor = WINDOW_START_MINUTE;
  for (const [s, e] of busy) {
    if (s - cursor >= minMinutes) slots.push({ dateKey, start: hhmm(cursor), end: hhmm(s) });
    cursor = Math.max(cursor, e);
  }
  if (WINDOW_END_MINUTE - cursor >= minMinutes) slots.push({ dateKey, start: hhmm(cursor), end: hhmm(WINDOW_END_MINUTE) });
  return slots;
}

/** dateFrom~dateTo(포함) 기간에서 minMinutes 이상 비어 있는 구간을 날짜순으로 찾는다. */
export async function findFreeSlots(
  dateFrom: string,
  dateTo: string,
  minMinutes: number,
): Promise<{ slots: FreeSlot[]; truncated: boolean }> {
  const tz = loadConfig().TIMEZONE;
  const { timeMin, timeMax } = dateRangeToISO(dateFrom, dateTo);
  const events = await listEvents(timeMin, timeMax);

  // 지금 이후만 보되, 분 단위로 딱 떨어지지 않게 나오지 않도록 5분 단위로 올림한다(예: 13:57 → 14:00).
  const nowMs = Math.ceil(Date.now() / 300_000) * 300_000;
  const slots: FreeSlot[] = [];
  for (let d = dateFrom; d <= dateTo; d = addDaysToDateKey(d, 1)) {
    const dayStartMs = dateKeyToUtcMs(d, tz);
    const dayEndMs = dateKeyToUtcMs(addDaysToDateKey(d, 1), tz);
    if (dayEndMs <= nowMs) continue; // 이미 지난 날
    const dayEvents = events.filter(
      (ev) => new Date(ev.start).getTime() < dayEndMs && new Date(ev.end).getTime() > dayStartMs,
    );
    slots.push(...computeFreeSlots(d, dayStartMs, dayEvents, minMinutes, nowMs > dayStartMs ? nowMs : undefined));
  }
  // listEvents가 최대 50건까지만 가져오므로, 꽉 찼으면 일부 일정이 빠졌을 수 있다.
  return { slots, truncated: events.length >= 50 };
}
