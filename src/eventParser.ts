// Discord 슬래시 명령어에 입력된 자연어 문장을 구조화된 데이터로 바꾸는 모듈.
// 별도의 Anthropic API 키 없이, 이 머신에 로그인되어 있는 `claude` CLI(Claude 구독 계정)를
// 비대화형(-p)으로 호출해서 처리한다. 세 가지 용도로 쓰인다:
//   1) parseEventText   — "다음주 화요일 2시 치과" → 일정 등록용 구조화 정보
//   2) parseEventUpdate — 기존 일정 + "3시로 변경" 같은 변경 요청 → 수정 후 최종 상태
//   3) parseSearchIntent — "내일 치과" 같은 검색 설명 → 키워드 + 날짜 범위
//      (반복 일정이면 recurrence도 함께 뽑아 RRULE로 변환한다)
//   4) parseTaskText / parseTaskUpdate — 할 일 등록/수정용 (제목 + 선택적 마감일)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { getTodayRange } from "./calendar.js";
import type { CalendarEvent, TaskItem } from "./calendar.js";

const execFileAsync = promisify(execFile);

/** "다음주", "내일" 같은 상대 표현을 정확히 계산할 수 있도록 system prompt에 넣을 오늘 날짜/요일/타임존 정보. */
function todayContext(): { dateKey: string; weekday: string; tz: string } {
  const config = loadConfig();
  const { dateKey } = getTodayRange();
  const weekday = new Intl.DateTimeFormat("ko-KR", {
    timeZone: config.TIMEZONE,
    weekday: "long",
  }).format(new Date());
  return { dateKey, weekday, tz: config.TIMEZONE };
}

/**
 * claude CLI 호출이 실패했을 때, 사용량 한도/rate limit/서버 과부하 같은 흔한 원인이면
 * 원인을 바로 알 수 있는 한국어 메시지로 바꿔준다 (Claude Code 공식 에러 문구 기준).
 * 해당 없으면 원본 메시지를 그대로 보여준다. Discord 명령어 핸들러가 이 메시지를 그대로 응답한다.
 */
function describeClaudeFailure(raw: string): string {
  const lower = raw.toLowerCase();
  const guide = " (잠시 후 다시 시도하거나, Google 캘린더 앱에서 직접 처리해주세요)";

  if (/(usage limit|hit your .*limit|limit reached)/.test(lower)) {
    return `Claude 사용량 한도에 도달해서 자연어 명령을 처리할 수 없습니다.${guide}`;
  }
  if (/(429|rate limit|rejected)/.test(lower)) {
    return `요청이 몰려 일시적으로 제한됐습니다(rate limit).${guide}`;
  }
  if (/(529|overloaded|high load|high demand)/.test(lower)) {
    return `Claude 서버가 일시적으로 과부하 상태입니다.${guide}`;
  }
  if (/(spend limit|credit balance)/.test(lower)) {
    return `Claude 결제/크레딧 한도 문제로 처리할 수 없습니다.${guide}`;
  }
  return `자연어 처리에 실패했습니다: ${raw}${guide}`;
}

/**
 * `claude` CLI를 비대화형으로 호출해 자연어를 구조화된 JSON으로 변환한다.
 * 별도 Anthropic API 키 없이, 로그인된 Claude 구독 계정을 그대로 사용한다.
 * `--tools ""`로 코드 실행 등 모든 도구를 꺼서 순수 텍스트 추출만 하도록 제한한다.
 *
 * 이 함수가 실패해도(사용량 한도 등) 호출하는 쪽(discord.ts의 각 명령어 핸들러)이 try/catch로
 * 감싸 에러 메시지만 응답하므로, 06:00 발송·폴링·날씨 같은 다른 기능에는 영향을 주지 않는다.
 */
async function callClaudeJson<T>(
  systemPrompt: string,
  jsonSchema: object,
  userText: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--system-prompt",
        systemPrompt,
        "--json-schema",
        JSON.stringify(jsonSchema),
        userText,
      ],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (err) {
    throw new Error(describeClaudeFailure((err as Error).message));
  }

  const parsed = JSON.parse(stdout);
  if (parsed.is_error || !parsed.structured_output) {
    throw new Error(describeClaudeFailure(parsed.result ?? "알 수 없는 오류"));
  }
  return schema.parse(parsed.structured_output);
}

const recurrenceSchema = z.object({
  freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
  interval: z.number().int().min(1).nullable().optional(),
  byDay: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).nullable().optional(),
  count: z.number().int().min(1).nullable().optional(),
});

type ParsedRecurrence = z.infer<typeof recurrenceSchema>;

/** 구조화된 반복 정보를 Google Calendar가 받는 RRULE 문자열로 조립한다. (LLM이 RRULE을 직접 쓰면 틀리기 쉬워서 코드에서 만든다) */
export function buildRecurrenceRules(r: ParsedRecurrence): string[] {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval && r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byDay?.length) parts.push(`BYDAY=${r.byDay.join(",")}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  return [`RRULE:${parts.join(";")}`];
}

const parsedEventSchema = z.object({
  title: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다"),
  allDay: z.boolean(),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .optional(),
  endTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .optional(),
  location: z.string().nullable().optional(),
  recurrence: recurrenceSchema.nullable().optional(),
});

/** 파서가 돌려주는 일정 정보. 반복 규칙은 이미 RRULE 문자열로 변환돼 있어 NewEventInput에 그대로 넘길 수 있다. */
export type ParsedEvent = Omit<z.infer<typeof parsedEventSchema>, "recurrence"> & { recurrence?: string[] | null };

function withRecurrenceRules(parsed: z.infer<typeof parsedEventSchema>): ParsedEvent {
  return { ...parsed, recurrence: parsed.recurrence ? buildRecurrenceRules(parsed.recurrence) : null };
}

const EVENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "일정 제목" },
    date: { type: "string", description: "YYYY-MM-DD 형식의 날짜" },
    allDay: { type: "boolean", description: "시간이 명시되지 않은 종일 일정이면 true" },
    startTime: { type: ["string", "null"], description: "HH:MM (24시간). allDay면 null" },
    endTime: { type: ["string", "null"], description: "HH:MM (24시간). 명시되지 않았으면 null" },
    location: { type: ["string", "null"], description: "장소. 없으면 null" },
    recurrence: {
      type: ["object", "null"],
      description: "반복 일정일 때만. 반복 표현(매일/매주/격주/매월/매년 등)이 없으면 null",
      properties: {
        freq: { type: "string", enum: ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] },
        interval: { type: ["integer", "null"], description: "간격. 격주면 2. 기본(매번)이면 null" },
        byDay: {
          type: ["array", "null"],
          items: { type: "string", enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] },
          description: "반복 요일. 요일 언급이 없으면 null",
        },
        count: { type: ["integer", "null"], description: "총 반복 횟수. 언급이 없으면 null(무기한)" },
      },
      required: ["freq"],
    },
  },
  required: ["title", "date", "allDay"],
};

/** 자연어 문장을 구조화된 일정 정보로 변환한다. (예: "다음주 화요일 2시 치과") */
export async function parseEventText(text: string): Promise<ParsedEvent> {
  const { dateKey, weekday, tz } = todayContext();
  const systemPrompt =
    `오늘 날짜는 ${dateKey}(${weekday})이고 타임존은 ${tz}이다. ` +
    `사용자의 한국어 문장에서 캘린더 일정 정보를 추출해라. ` +
    `시간이 명시되지 않았으면 allDay를 true로, 종료 시간이 명시되지 않았으면 endTime을 null로 둬라. ` +
    `"매주 화요일"처럼 반복 표현이 있으면 recurrence를 채우고, date는 반복의 첫 번째 날짜(오늘 이후 가장 가까운 해당 요일 등)로 해라. 반복 표현이 없으면 recurrence는 null이다.`;
  return withRecurrenceRules(await callClaudeJson(systemPrompt, EVENT_JSON_SCHEMA, text, parsedEventSchema));
}

/** 기존 일정 + 변경 요청 문장을 합쳐 "수정 후 최종 상태"를 만든다. 언급되지 않은 필드는 기존 값을 유지한다. */
export async function parseEventUpdate(current: CalendarEvent, instruction: string): Promise<ParsedEvent> {
  const { dateKey, weekday, tz } = todayContext();
  const currentDate = current.start.slice(0, 10);
  const currentStartTime = current.allDay ? null : current.start.slice(11, 16);
  const currentEndTime = current.allDay ? null : current.end.slice(11, 16);

  const systemPrompt =
    `오늘 날짜는 ${dateKey}(${weekday})이고 타임존은 ${tz}이다. ` +
    `기존 일정: 제목="${current.title}", 날짜=${currentDate}, 종일=${current.allDay}, ` +
    `시작시간=${currentStartTime ?? "없음"}, 종료시간=${currentEndTime ?? "없음"}, 장소=${current.location ?? "없음"}. ` +
    `사용자의 변경 요청 문장을 반영해 수정 후 최종 일정 정보를 JSON으로 출력해라. ` +
    `문장에서 언급되지 않은 항목은 위 기존 값을 그대로 유지해라. ` +
    `반복 규칙을 바꾸라는 언급이 없으면 recurrence는 반드시 null로 둬라(null은 "기존 반복 유지"를 뜻한다).`;
  return withRecurrenceRules(await callClaudeJson(systemPrompt, EVENT_JSON_SCHEMA, instruction, parsedEventSchema));
}

const searchIntentSchema = z.object({
  keyword: z.string().nullable().optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

export type SearchIntent = z.infer<typeof searchIntentSchema>;

const SEARCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    keyword: { type: ["string", "null"], description: "일정 제목에서 찾을 핵심 단어(날짜 표현 제외). 없으면 null" },
    dateFrom: { type: ["string", "null"], description: "YYYY-MM-DD, 검색 시작일. 날짜/기간 언급이 없으면 null" },
    dateTo: {
      type: ["string", "null"],
      description: "YYYY-MM-DD, 검색 종료일. 특정 하루만 언급됐으면 dateFrom과 동일하게. 언급 없으면 null",
    },
  },
  required: [],
};

/** "내일 치과", "이번주", "치과 예약" 같은 문장에서 검색용 키워드/날짜 범위를 뽑아낸다. */
export async function parseSearchIntent(text: string): Promise<SearchIntent> {
  const { dateKey, weekday, tz } = todayContext();
  const systemPrompt =
    `오늘 날짜는 ${dateKey}(${weekday})이고 타임존은 ${tz}이다. ` +
    `사용자 문장에서 일정을 찾기 위한 키워드와 날짜 범위를 추출해라.`;
  return callClaudeJson(systemPrompt, SEARCH_JSON_SCHEMA, text, searchIntentSchema);
}

const parsedTaskSchema = z.object({
  title: z.string().min(1),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다")
    .nullable()
    .optional(),
});

export type ParsedTask = z.infer<typeof parsedTaskSchema>;

const TASK_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "할 일 제목 (날짜 표현 제외)" },
    date: { type: ["string", "null"], description: "YYYY-MM-DD 형식의 마감일. 언급이 없으면 null" },
  },
  required: ["title"],
};

/** 자연어 문장을 할 일 정보로 변환한다. (예: "내일까지 보고서 제출") */
export async function parseTaskText(text: string): Promise<ParsedTask> {
  const { dateKey, weekday, tz } = todayContext();
  const systemPrompt =
    `오늘 날짜는 ${dateKey}(${weekday})이고 타임존은 ${tz}이다. ` +
    `사용자의 한국어 문장에서 할 일 제목과 마감일을 추출해라. 마감일이 언급되지 않았으면 date를 null로 둬라.`;
  return callClaudeJson(systemPrompt, TASK_JSON_SCHEMA, text, parsedTaskSchema);
}

/** 기존 할 일 + 변경 요청 문장을 합쳐 "수정 후 최종 상태"를 만든다. 언급되지 않은 항목은 기존 값을 유지한다. */
export async function parseTaskUpdate(current: TaskItem, instruction: string): Promise<ParsedTask> {
  const { dateKey, weekday, tz } = todayContext();
  const systemPrompt =
    `오늘 날짜는 ${dateKey}(${weekday})이고 타임존은 ${tz}이다. ` +
    `기존 할 일: 제목="${current.title}", 마감일=${current.due ?? "없음"}. ` +
    `사용자의 변경 요청 문장을 반영해 수정 후 최종 할 일 정보를 JSON으로 출력해라. ` +
    `문장에서 언급되지 않은 항목은 위 기존 값을 그대로 유지하고, 마감일을 없애라고 하면 date를 null로 둬라.`;
  return callClaudeJson(systemPrompt, TASK_JSON_SCHEMA, instruction, parsedTaskSchema);
}
