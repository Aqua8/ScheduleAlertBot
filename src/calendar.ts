// Google Calendar 연동 전체를 담당하는 모듈.
// - OAuth 클라이언트 생성/토큰 로드
// - 일정 조회(오늘 범위, 임의 기간, 키워드 검색)
// - 일정 등록/수정/삭제 (calendar.events 쓰기 권한 필요)
// - 타임존을 고려한 날짜 계산 유틸(자정 경계, 격일 등)
import { google, calendar_v3 } from "googleapis";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, DATA_DIR } from "./config.js";

export interface CalendarEvent {
  id: string;
  title: string;
  /** all-day 이벤트면 true */
  allDay: boolean;
  /** ISO 문자열. all-day면 날짜만 */
  start: string;
  end: string;
  location?: string;
  /** 반복 일정의 한 회차이면 원본(반복 규칙을 가진) 일정의 id */
  recurringEventId?: string;
  /** 반복 규칙(RRULE). 반복 일정의 원본 일정에만 있다 */
  recurrence?: string[];
}

const TOKEN_PATH = fileURLToPath(new URL("google-token.json", DATA_DIR));

/** 저장된 refresh token(`data/google-token.json`)으로 인증된 OAuth 클라이언트를 만든다. 토큰이 없으면 재로그인을 안내한다. */
async function getOAuthClient() {
  const config = loadConfig();
  const oAuth2Client = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    "http://localhost:53682/oauth2callback",
  );

  let tokenRaw: string;
  try {
    tokenRaw = await readFile(TOKEN_PATH, "utf-8");
  } catch {
    throw new Error(
      `Google 인증 토큰이 없습니다. 먼저 'npm run auth:google'을 실행해 로그인하세요. (찾는 경로: ${TOKEN_PATH})`,
    );
  }
  oAuth2Client.setCredentials(JSON.parse(tokenRaw));
  return oAuth2Client;
}

/** 인증된 Calendar API v3 클라이언트. 조회/등록/수정/삭제 함수들이 공통으로 사용한다. */
async function getCalendarClient() {
  const auth = await getOAuthClient();
  return google.calendar({ version: "v3", auth });
}

/** Google API의 원본 이벤트 응답을 우리 앱 내부 형태(CalendarEvent)로 변환한다. */
function mapEvent(e: calendar_v3.Schema$Event, fallbackTitle = "(제목 없음)"): CalendarEvent {
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  return {
    id: e.id ?? "",
    title: e.summary ?? fallbackTitle,
    allDay,
    start: (allDay ? e.start?.date : e.start?.dateTime) ?? "",
    end: (allDay ? e.end?.date : e.end?.dateTime) ?? "",
    location: e.location ?? undefined,
    recurringEventId: e.recurringEventId ?? undefined,
    recurrence: e.recurrence ?? undefined,
  };
}

/** Date를 지정한 타임존 기준 "YYYY-MM-DD" 문자열로 바꾼다. */
function formatDateKeyInTz(date: Date, tz: string): string {
  // Intl로 타임존 기준 연/월/일을 뽑아낸다 (서버 로컬 타임존에 의존하지 않기 위함)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/** 특정 시각에 지정한 타임존이 UTC보다 몇 분 앞서 있는지 계산한다 (Asia/Seoul은 항상 +540분). */
function getTimezoneOffsetMinutes(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** "YYYY-MM-DD" 날짜의, 지정한 타임존 기준 자정(00:00)을 UTC 밀리초로 변환한다. */
export function dateKeyToUtcMs(dateKey: string, tz: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const offsetMinutes = getTimezoneOffsetMinutes(tz, new Date(Date.UTC(y, m - 1, d)));
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * 60_000;
}

/** "YYYY-MM-DD" 날짜에 n일을 더한(음수면 뺀) 새 날짜 문자열을 반환한다. */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "HH:MM" 시각에 분을 더한다. 24시간을 넘기면 다시 00:00부터 순환한다(날짜는 바뀌지 않음). */
function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (((h * 60 + m + minutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** startDateKey 00:00 ~ endDateKey(포함) 24:00 범위를 설정된 타임존 기준 ISO(오프셋 포함)로 반환 */
export function dateRangeToISO(startDateKey: string, endDateKeyInclusive: string): { timeMin: string; timeMax: string } {
  const config = loadConfig();
  const tz = config.TIMEZONE;
  const startMs = dateKeyToUtcMs(startDateKey, tz);
  const endMs = dateKeyToUtcMs(addDaysToDateKey(endDateKeyInclusive, 1), tz);
  return { timeMin: new Date(startMs).toISOString(), timeMax: new Date(endMs).toISOString() };
}

/** Asia/Seoul 등 설정된 타임존 기준 "오늘"의 00:00 ~ 24:00 범위를 ISO(오프셋 포함)로 반환 */
export function getTodayRange(now = new Date()): { timeMin: string; timeMax: string; dateKey: string } {
  const config = loadConfig();
  const dateKey = formatDateKeyInTz(now, config.TIMEZONE);
  const { timeMin, timeMax } = dateRangeToISO(dateKey, dateKey);
  return { timeMin, timeMax, dateKey };
}

/** 주어진 기간의 일정을 조회한다. q를 주면 제목/설명/장소에서 키워드로 필터링한다. */
export async function listEvents(timeMin: string, timeMax: string, q?: string): Promise<CalendarEvent[]> {
  const config = loadConfig();
  const calendar = await getCalendarClient();

  const res = await calendar.events.list({
    calendarId: config.GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    q,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const items = res.data.items ?? [];
  return items.filter((e) => e.status !== "cancelled").map((e) => mapEvent(e));
}

/** 오늘 하루(설정된 타임존 기준)의 일정만 조회한다. 06:00 발송과 5분 폴링에서 사용. */
export async function getTodayEvents(now = new Date()): Promise<CalendarEvent[]> {
  const { timeMin, timeMax } = getTodayRange(now);
  return listEvents(timeMin, timeMax);
}

export interface TaskItem {
  id: string;
  title: string;
  tasklistId: string;
  /** YYYY-MM-DD. 마감일이 없으면 undefined */
  due?: string;
}

export interface NewTaskInput {
  title: string;
  /** YYYY-MM-DD, 마감일 없으면 null */
  date?: string | null;
}

/** 인증된 Tasks API v1 클라이언트. 할 일 조회/등록/수정/삭제 함수들이 공통으로 사용한다. */
async function getTasksClient() {
  const auth = await getOAuthClient();
  return google.tasks({ version: "v1", auth });
}

/** Tasks API의 마감일은 시간 정보 없이 날짜만 의미가 있고 UTC 자정으로 저장된다. */
function dateKeyToTaskDue(dateKey: string): string {
  return `${dateKey}T00:00:00.000Z`;
}

/** 모든 할 일 목록의 미완료 할 일을 조회한다. dueRange를 주면 마감일이 그 범위(포함, 한쪽만 줘도 됨)인 것만 가져온다. (tasks 권한 필요) */
export async function listTasks(dueRange?: { dateFrom?: string; dateTo?: string }): Promise<TaskItem[]> {
  const tasksApi = await getTasksClient();

  const lists = await tasksApi.tasklists.list({ maxResults: 100 });
  const result: TaskItem[] = [];
  for (const list of lists.data.items ?? []) {
    const res = await tasksApi.tasks.list({
      tasklist: list.id!,
      showCompleted: false,
      dueMin: dueRange?.dateFrom ? dateKeyToTaskDue(dueRange.dateFrom) : undefined,
      dueMax: dueRange?.dateTo ? dateKeyToTaskDue(addDaysToDateKey(dueRange.dateTo, 1)) : undefined,
      maxResults: 100,
    });
    for (const t of res.data.items ?? []) {
      if (t.status === "completed") continue;
      result.push({
        id: t.id ?? "",
        title: t.title || "(제목 없음)",
        tasklistId: list.id!,
        due: t.due?.slice(0, 10),
      });
    }
  }
  return result;
}

/** 마감일이 해당 날짜(YYYY-MM-DD)인 미완료 할 일을 조회한다. */
export async function getTasksOnDate(dateKey: string): Promise<TaskItem[]> {
  return listTasks({ dateFrom: dateKey, dateTo: dateKey });
}

/** 오늘이 마감일인 미완료 할 일을 조회한다. */
export async function getTodayTasks(now = new Date()): Promise<TaskItem[]> {
  return getTasksOnDate(getTodayRange(now).dateKey);
}

/** 마감일이 오늘보다 이전인(= 밀린) 미완료 할 일을 조회한다. */
export async function getOverdueTasks(now = new Date()): Promise<TaskItem[]> {
  const { dateKey } = getTodayRange(now);
  return listTasks({ dateTo: addDaysToDateKey(dateKey, -1) });
}

/** 기본 할 일 목록에 새 할 일을 등록한다. */
export async function createTask(input: NewTaskInput): Promise<TaskItem> {
  const tasksApi = await getTasksClient();
  const res = await tasksApi.tasks.insert({
    tasklist: "@default",
    requestBody: { title: input.title, due: input.date ? dateKeyToTaskDue(input.date) : undefined },
  });
  return { id: res.data.id ?? "", title: res.data.title ?? input.title, tasklistId: "@default", due: res.data.due?.slice(0, 10) };
}

/** 기존 할 일의 제목/마감일을 새 내용으로 바꾼다. 마감일이 null이면 마감일을 지운다. */
export async function updateTask(task: TaskItem, input: NewTaskInput): Promise<TaskItem> {
  const tasksApi = await getTasksClient();
  const res = await tasksApi.tasks.patch({
    tasklist: task.tasklistId,
    task: task.id,
    requestBody: { title: input.title, due: input.date ? dateKeyToTaskDue(input.date) : null },
  });
  return { id: task.id, title: res.data.title ?? input.title, tasklistId: task.tasklistId, due: res.data.due?.slice(0, 10) };
}

/** 할 일을 완료 처리한다. 완료 기록이 남고 Google Tasks 앱에서 되돌릴 수 있다. */
export async function completeTask(task: TaskItem): Promise<void> {
  const tasksApi = await getTasksClient();
  await tasksApi.tasks.patch({ tasklist: task.tasklistId, task: task.id, requestBody: { status: "completed" } });
}

/** 할 일을 영구 삭제한다. 되돌릴 수 없으므로 호출 전 Discord에서 확인을 받는다. */
export async function deleteTask(task: TaskItem): Promise<void> {
  const tasksApi = await getTasksClient();
  await tasksApi.tasks.delete({ tasklist: task.tasklistId, task: task.id });
}

export interface NewEventInput {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  allDay: boolean;
  /** HH:MM, allDay면 무시 */
  startTime?: string | null;
  /** HH:MM, 없으면 startTime + 1시간 */
  endTime?: string | null;
  location?: string | null;
  /** RRULE 문자열 목록(예: ["RRULE:FREQ=WEEKLY;BYDAY=TU"]). 없으면 반복하지 않는다 */
  recurrence?: string[] | null;
}

/** NewEventInput(파서가 뽑아낸 정보)을 Google Calendar API가 요구하는 요청 본문으로 변환한다. createEvent/updateEvent 공용. */
function buildEventRequestBody(input: NewEventInput): calendar_v3.Schema$Event {
  const config = loadConfig();
  const body: calendar_v3.Schema$Event = {
    summary: input.title,
    location: input.location ?? undefined,
    recurrence: input.recurrence?.length ? input.recurrence : undefined,
  };

  if (input.allDay || !input.startTime) {
    body.start = { date: input.date };
    body.end = { date: addDaysToDateKey(input.date, 1) };
  } else {
    const endTime = input.endTime ?? addMinutesToTime(input.startTime, 60);
    body.start = { dateTime: `${input.date}T${input.startTime}:00`, timeZone: config.TIMEZONE };
    body.end = { dateTime: `${input.date}T${endTime}:00`, timeZone: config.TIMEZONE };
  }
  return body;
}

/** 일정 하나를 id로 조회한다. 반복 일정 회차에서 원본 일정을 가져올 때 쓴다. */
export async function getEvent(eventId: string): Promise<CalendarEvent> {
  const config = loadConfig();
  const calendar = await getCalendarClient();
  const res = await calendar.events.get({ calendarId: config.GOOGLE_CALENDAR_ID, eventId });
  return mapEvent(res.data);
}

/** 등록하려는 일정과 시간이 겹치는 기존 일정을 찾는다. 종일 일정은 비교하지 않고, 반복 일정은 첫 회차만 확인한다. */
export async function findConflictingEvents(input: NewEventInput): Promise<CalendarEvent[]> {
  if (input.allDay || !input.startTime) return [];

  const config = loadConfig();
  const dayStartMs = dateKeyToUtcMs(input.date, config.TIMEZONE);
  const toMs = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return dayStartMs + (h * 60 + m) * 60_000;
  };
  const startMs = toMs(input.startTime);
  const endMs = toMs(input.endTime ?? addMinutesToTime(input.startTime, 60));

  const { timeMin, timeMax } = dateRangeToISO(input.date, input.date);
  const events = await listEvents(timeMin, timeMax);
  return events.filter(
    (ev) => !ev.allDay && new Date(ev.start).getTime() < endMs && new Date(ev.end).getTime() > startMs,
  );
}

/** 자연어에서 파싱된 정보로 캘린더에 새 일정을 등록한다. (calendar.events 쓰기 권한 필요) */
export async function createEvent(input: NewEventInput): Promise<CalendarEvent> {
  const config = loadConfig();
  const calendar = await getCalendarClient();
  const res = await calendar.events.insert({
    calendarId: config.GOOGLE_CALENDAR_ID,
    requestBody: buildEventRequestBody(input),
  });
  return mapEvent(res.data, input.title);
}

/** 기존 일정을 새 내용으로 통째로 교체한다(부분 필드만 바뀌어도 나머지는 파서가 기존 값을 채워 넘긴다). */
export async function updateEvent(eventId: string, input: NewEventInput): Promise<CalendarEvent> {
  const config = loadConfig();
  const calendar = await getCalendarClient();
  const res = await calendar.events.update({
    calendarId: config.GOOGLE_CALENDAR_ID,
    eventId,
    requestBody: buildEventRequestBody(input),
  });
  return mapEvent(res.data, input.title);
}

/** 캘린더에서 일정을 영구 삭제한다. 되돌릴 수 없으므로 호출 전 Discord에서 확인을 받는다. */
export async function deleteEvent(eventId: string): Promise<void> {
  const config = loadConfig();
  const calendar = await getCalendarClient();
  await calendar.events.delete({ calendarId: config.GOOGLE_CALENDAR_ID, eventId });
}

export { getOAuthClient };
