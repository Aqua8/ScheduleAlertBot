// Discord 메시지에 실제로 표시되는 텍스트를 만드는 모듈. 캘린더/날씨 데이터를 사람이 읽기 좋은
// 형태로 조합하는 역할만 하고, API 호출이나 상태 변경은 하지 않는다(순수 포맷팅 함수 모음).
import { loadConfig } from "./config.js";
import type { CalendarEvent, TaskItem } from "./calendar.js";
import type { WeatherSummary } from "./weather.js";

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** "YYYY-MM-DD" → "9/28(월)" 형태로 변환 */
function formatDateHeader(dateKey: string, tz: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
    new Date(`${dateKey}T12:00:00Z`),
  );
  const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  return `${m}/${d}(${WEEKDAYS_KO[idx] ?? "?"})`;
}

/** 종일 일정이면 "종일", 아니면 "14:00-15:00"(시작=종료면 "14:00")처럼 시간 범위를 표시 */
function formatTimeRange(ev: CalendarEvent, tz: string): string {
  if (ev.allDay) return "종일";
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  const fmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const startStr = fmt.format(start);
  const endStr = fmt.format(end);
  if (startStr === endStr) return startStr;
  return `${startStr}-${endStr}`;
}

/** 일정 하나를 "• 14:00-15:00  치과 @강남" 한 줄로. marker를 주면 "•" 대신 그 표시(예: 🆕)를 붙인다. */
function eventLine(ev: CalendarEvent, tz: string, marker?: string): string {
  const time = formatTimeRange(ev, tz);
  const loc = ev.location ? ` @${ev.location}` : "";
  const prefix = marker ? `${marker} ` : "• ";
  return `${prefix}${time}  ${ev.title}${loc}`;
}

export interface DailySummary {
  dateKey: string;
  events: CalendarEvent[];
  /** 오늘 마감인 할 일. 조회하지 못했으면 생략 */
  tasks?: TaskItem[];
}

/** 오늘 날씨 + 우산/빨래 안내 한 줄 (06:00 발송용, `/오늘날씨` 명령어 공용) */
export function formatWeatherLine(weather: WeatherSummary): string {
  const tempPart =
    weather.minTemp !== null && weather.maxTemp !== null
      ? `${weather.minTemp}°~${weather.maxTemp}°`
      : "기온 정보 없음";
  const icon = weather.hasPrecipitation ? "🌧️" : weather.maxPop >= 50 ? "🌦️" : "🌤️";
  const umbrellaText = weather.umbrella ? "☔ 우산 챙기세요" : "☀️ 우산 필요 없어요";
  const laundryText = weather.laundryOk ? "🧺 빨래 널어도 좋아요" : "🚫 빨래는 다음 기회에";
  const periods = weather.precipitationPeriods.map((p) => `${p.label} ${p.start}~${p.end}`).join(", ");
  const periodLine = periods ? `\n${periods}` : "";
  return `${icon} 오늘 날씨: ${tempPart}, 강수확률 최대 ${weather.maxPop}%${periodLine}\n${umbrellaText} · ${laundryText}`;
}

/** 06:00 아침 발송용 텍스트 (Discord 메시지 본문 / 콘솔 출력 공용). weather를 주면 상단에 날씨 안내를 덧붙인다. */
export function formatDailySummary(summary: DailySummary, weather?: WeatherSummary): string {
  const config = loadConfig();
  const header = formatDateHeader(summary.dateKey, config.TIMEZONE);

  const body =
    summary.events.length === 0
      ? `📅 ${header} 오늘 일정 없음`
      : [`📅 ${header} 오늘 일정 (${summary.events.length})`, ...summary.events.map((ev) => eventLine(ev, config.TIMEZONE))].join(
          "\n",
        );

  const tasks = summary.tasks ?? [];
  const withTasks =
    tasks.length === 0 ? body : `${body}\n\n✅ 오늘 할 일 (${tasks.length})\n${tasks.map((t) => `• ${t.title}`).join("\n")}`;

  if (!weather) return withTasks;
  return `${formatWeatherLine(weather)}\n\n${withTasks}`;
}

/**
 * 변경 후 오늘 일정 전체 목록. 이전 이벤트 id 집합과 비교해 새로 생긴 항목은 🆕로 표시하고
 * 맨 아래에 수정 시각을 덧붙인다. (Discord 수정 / 카카오 재발송 공용)
 */
export function formatUpdatedSummary(
  summary: DailySummary,
  previousEventIds: Set<string>,
  updatedAt: Date,
): string {
  const config = loadConfig();
  const header = formatDateHeader(summary.dateKey, config.TIMEZONE);

  const timeFmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: config.TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  let body: string;
  if (summary.events.length === 0) {
    body = `📅 ${header} 오늘 일정 없음`;
  } else {
    const lines = summary.events.map((ev) =>
      eventLine(ev, config.TIMEZONE, previousEventIds.has(ev.id) ? undefined : "🆕"),
    );
    body = [`📅 ${header} 오늘 일정 (${summary.events.length})`, ...lines].join("\n");
  }

  return `${body}\n\n_(수정됨 ${timeFmt.format(updatedAt)})_`;
}

/** 일정 하나의 요약 정보 (등록/수정/삭제 확인 메시지 공용) */
export function formatEventBrief(ev: CalendarEvent): string {
  const config = loadConfig();
  const dateInfo = ev.start.slice(0, 10);
  const timeInfo = formatTimeRange(ev, config.TIMEZONE);
  const locationLine = ev.location ? `\n장소: ${ev.location}` : "";
  return `제목: ${ev.title}\n날짜: ${dateInfo}\n시간: ${timeInfo}${locationLine}`;
}

/** `/일정목록`용: 기간 내 일정을 날짜별로 묶어서 보여준다. */
export function formatEventList(dateFrom: string, dateTo: string, events: CalendarEvent[]): string {
  const config = loadConfig();
  const rangeLabel =
    dateFrom === dateTo
      ? formatDateHeader(dateFrom, config.TIMEZONE)
      : `${formatDateHeader(dateFrom, config.TIMEZONE)} ~ ${formatDateHeader(dateTo, config.TIMEZONE)}`;

  if (events.length === 0) {
    return `📋 ${rangeLabel} 일정 없음`;
  }

  const byDate = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = ev.start.slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(ev);
  }

  const lines: string[] = [`📋 ${rangeLabel} 일정 (${events.length})`];
  for (const [dateKey, dayEvents] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`\n${formatDateHeader(dateKey, config.TIMEZONE)}`);
    for (const ev of dayEvents) {
      lines.push(eventLine(ev, config.TIMEZONE));
    }
  }
  return lines.join("\n");
}

/** 여러 후보 일정 중 하나를 특정해달라고 안내할 때 쓰는 짧은 목록 */
export function formatEventCandidates(events: CalendarEvent[]): string {
  const config = loadConfig();
  return events
    .slice(0, 10)
    .map((ev) => {
      const dateLabel = formatDateHeader(ev.start.slice(0, 10), config.TIMEZONE);
      const time = formatTimeRange(ev, config.TIMEZONE);
      const loc = ev.location ? ` @${ev.location}` : "";
      return `- ${dateLabel} ${time}  ${ev.title}${loc}`;
    })
    .join("\n");
}

/** 카카오톡 텍스트 템플릿 200자 제한에 맞춰 여러 메시지로 분할한다. (2단계에서 사용) */
export function splitForKakao(text: string, limit = 200): string[] {
  if (text.length <= limit) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit - 10) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  const total = chunks.length;
  return chunks.map((c, i) => (total > 1 ? `[${i + 1}/${total}]\n${c}` : c));
}
