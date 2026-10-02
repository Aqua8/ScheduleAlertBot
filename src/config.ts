// 환경변수(.env)를 zod 스키마로 읽고 검증하는 단일 진입점.
// Google/시간대 값은 항상 필요해서 필수로 두고, Discord/날씨처럼 기능별로만 필요한 값은
// optional로 뒀다가 그 기능을 실제로 쓰는 시점에 require*Config()로 따로 검증한다.
import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID가 필요합니다"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET이 필요합니다"),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),

  // Discord 값은 optional로 두고, 실제로 Discord를 쓰는 시점(requireDiscordConfig)에 검증한다.
  // 이렇게 해야 --dry-run처럼 Google 캘린더만 필요한 흐름이 Discord 설정 없이도 동작한다.
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  DISCORD_TARGET_TYPE: z.enum(["channel", "dm"]).default("channel"),
  DISCORD_TARGET_ID: z.string().optional(),

  TIMEZONE: z.string().default("Asia/Seoul"),
  // 내일 일정/할 일/날씨를 미리 보내는 저녁 발송 시각 (HH:MM, 24시간)
  EVENING_SEND_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 형식이어야 합니다").default("21:00"),

  // 기상청 날씨 정보(우산/빨래 판단). optional로 두고 requireWeatherConfig()에서 검증한다.
  // 키가 없으면 06시 발송 시 날씨 부분만 조용히 건너뛴다.
  KMA_SERVICE_KEY: z.string().optional(),
  WEATHER_NX: z.coerce.number().optional(),
  WEATHER_NY: z.coerce.number().optional(),
  UMBRELLA_POP_THRESHOLD: z.coerce.number().default(50),
  LAUNDRY_POP_THRESHOLD: z.coerce.number().default(30),
});

// 스크립트마다 필요한 값이 다르므로(예: register-commands는 캘린더 값이 필요 없음)
// 여기서는 파싱하지 않고, 사용하는 쪽에서 loadConfig()를 호출해 필요한 시점에 검증한다.
export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `환경변수 설정이 올바르지 않습니다. .env 파일을 확인하세요 (.env.example 참고):\n${issues}`,
    );
  }
  cached = parsed.data;
  return cached;
}

export const DATA_DIR = new URL("../data/", import.meta.url);

/** Discord 기능을 실제로 사용하는 지점(봇 로그인, 명령어 등록 등)에서 호출해 필요한 값을 검증한다. */
export function requireDiscordConfig(
  config: AppConfig,
): asserts config is AppConfig & {
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_TARGET_ID: string;
} {
  const missing = (["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_TARGET_ID"] as const).filter(
    (key) => !config[key],
  );
  if (missing.length > 0) {
    throw new Error(
      `Discord 기능을 사용하려면 .env에 다음 값이 필요합니다: ${missing.join(", ")}`,
    );
  }
}

/** 날씨 기능을 실제로 사용하는 지점에서 호출해 필요한 값을 검증한다. */
export function requireWeatherConfig(
  config: AppConfig,
): asserts config is AppConfig & { KMA_SERVICE_KEY: string; WEATHER_NX: number; WEATHER_NY: number } {
  const missing = (["KMA_SERVICE_KEY", "WEATHER_NX", "WEATHER_NY"] as const).filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`날씨 기능을 사용하려면 .env에 다음 값이 필요합니다: ${missing.join(", ")}`);
  }
}
