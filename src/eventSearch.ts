// `/일정수정`, `/일정삭제`가 "어떤 일정을 말하는지"를 자연어로부터 찾아내는 모듈.
// eventParser의 parseSearchIntent로 키워드/날짜범위를 뽑은 뒤 캘린더를 실제로 검색한다.
import { listEvents, dateRangeToISO, addDaysToDateKey, getTodayRange } from "./calendar.js";
import type { CalendarEvent } from "./calendar.js";
import { parseSearchIntent } from "./eventParser.js";

/**
 * 자연어 설명("내일 치과", "치과 예약")으로 캘린더에서 일정을 찾는다.
 * 날짜가 언급되지 않으면 오늘 기준 -7일 ~ +60일 범위에서 찾는다.
 */
export async function findMatchingEvents(text: string): Promise<CalendarEvent[]> {
  const intent = await parseSearchIntent(text);
  const { dateKey: today } = getTodayRange();
  const dateFrom = intent.dateFrom ?? addDaysToDateKey(today, -7);
  const dateTo = intent.dateTo ?? intent.dateFrom ?? addDaysToDateKey(today, 60);

  const { timeMin, timeMax } = dateRangeToISO(dateFrom, dateTo);
  return listEvents(timeMin, timeMax, intent.keyword ?? undefined);
}
