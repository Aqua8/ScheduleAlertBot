// 기상청 단기예보(동네예보)를 조회해서 오늘 강수확률/기온을 요약하고,
// 우산을 챙길지 빨래를 널어도 될지 판단하는 모듈.
import { loadConfig, requireWeatherConfig } from "./config.js";
import { getTodayRange, addDaysToDateKey } from "./calendar.js";

// 기상청 API 허브(apihub.kma.go.kr). 공공데이터포털(data.go.kr)과는 별개 시스템으로,
// 인증 파라미터명이 serviceKey가 아니라 authKey이고 엔드포인트도 다르다.
const KMA_BASE_URL = "https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getVilageFcst";

interface ForecastItem {
  fcstDate: string; // YYYYMMDD
  fcstTime: string; // HHMM
  category: string;
  fcstValue: string;
}

export interface PrecipitationPeriod {
  /** 비, 눈, 비/눈, 소나기 */
  label: string;
  /** "HH:MM" */
  start: string;
  /** "HH:MM" — 마지막 예보 시각의 1시간 뒤 */
  end: string;
}

// PTY(강수형태) 코드 → 표시 이름. 0(없음)은 포함하지 않는다.
const PTY_LABELS: Record<number, string> = { 1: "비", 2: "비/눈", 3: "눈", 4: "소나기" };

/** 시간대별 강수형태(PTY) 예보를 연속된 구간으로 묶는다. 예보는 1시간 간격이라 마지막 시각 +1시간을 종료로 본다. */
function buildPrecipitationPeriods(todays: ForecastItem[]): PrecipitationPeriod[] {
  const hours = todays
    .filter((it) => it.category === "PTY" && Number(it.fcstValue) !== 0)
    .map((it) => ({ hour: Number(it.fcstTime.slice(0, 2)), label: PTY_LABELS[Number(it.fcstValue)] ?? "강수" }))
    .sort((a, b) => a.hour - b.hour);

  const periods: { startHour: number; endHour: number; labels: Set<string> }[] = [];
  for (const { hour, label } of hours) {
    const last = periods[periods.length - 1];
    if (last && hour === last.endHour) {
      last.endHour = hour + 1;
      last.labels.add(label);
    } else {
      periods.push({ startHour: hour, endHour: hour + 1, labels: new Set([label]) });
    }
  }

  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return periods.map((p) => ({ label: [...p.labels].join("/"), start: hh(p.startHour), end: hh(p.endHour) }));
}

export interface WeatherSummary {
  /** 섭씨. 정보가 없으면 null */
  minTemp: number | null;
  maxTemp: number | null;
  /** 오늘 시간대 중 최대 강수확률(%) */
  maxPop: number;
  /** 오늘 시간대 중 실제 강수/강설 예보(PTY != 0)가 하나라도 있는지 */
  hasPrecipitation: boolean;
  /** 비/눈이 오는 시간대 (연속된 시간끼리 묶음). 없으면 빈 배열 */
  precipitationPeriods: PrecipitationPeriod[];
  /** 우산을 챙기는 게 좋은지 */
  umbrella: boolean;
  /** 빨래를 널어도 좋은지 */
  laundryOk: boolean;
}

/** 특정 발표 시각(baseDate+baseTime)의 단기예보 원본 항목들을 API 허브에서 가져온다. */
async function fetchForecastItems(baseDate: string, baseTime: string): Promise<ForecastItem[]> {
  const config = loadConfig();
  requireWeatherConfig(config);

  const url = new URL(KMA_BASE_URL);
  url.searchParams.set("authKey", config.KMA_SERVICE_KEY);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "1000");
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("base_date", baseDate);
  url.searchParams.set("base_time", baseTime);
  url.searchParams.set("nx", String(config.WEATHER_NX));
  url.searchParams.set("ny", String(config.WEATHER_NY));

  const res = await fetch(url);
  const json = (await res.json()) as {
    response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { items?: { item?: ForecastItem[] } } };
  };

  const header = json.response?.header;
  if (!header || header.resultCode !== "00") {
    throw new Error(`기상청 API 오류(${baseDate} ${baseTime}): ${header?.resultMsg ?? `HTTP ${res.status}`}`);
  }
  return json.response?.body?.items?.item ?? [];
}

/** 발표 시각 후보를 순서대로 시도해 처음 성공한 예보를 쓴다. 전부 실패하면 마지막 오류로 던진다. */
async function fetchFirstAvailableForecast(attempts: [string, string][]): Promise<ForecastItem[]> {
  let lastError: unknown;
  for (const [baseDate, baseTime] of attempts) {
    try {
      return await fetchForecastItems(baseDate, baseTime);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`기상청 예보를 가져오지 못했습니다: ${(lastError as Error)?.message ?? "알 수 없는 오류"}`);
}

/** KMA 단기예보는 02/05/08/11/14/17/20/23시에 발표되고 ~10분 뒤 조회 가능해진다. 06시 발송 기준 05시 발표분을 우선 쓰고, 실패하면 이전 발표분으로 넘어간다. */
async function fetchTodayForecastItems(todayDateKey: string): Promise<ForecastItem[]> {
  const todayBaseDate = todayDateKey.replace(/-/g, "");
  const yesterdayBaseDate = addDaysToDateKey(todayDateKey, -1).replace(/-/g, "");

  return fetchFirstAvailableForecast([
    [todayBaseDate, "0500"],
    [todayBaseDate, "0200"],
    [yesterdayBaseDate, "2300"],
  ]);
}

/** 저녁(21시) 발송 기준으로 내일 예보를 담고 있는 오늘 20시 발표분을 우선 쓰고, 실패하면 이전 발표분으로 넘어간다. */
async function fetchTomorrowForecastItems(todayDateKey: string): Promise<ForecastItem[]> {
  const todayBaseDate = todayDateKey.replace(/-/g, "");
  return fetchFirstAvailableForecast([
    [todayBaseDate, "2000"],
    [todayBaseDate, "1700"],
    [todayBaseDate, "1400"],
  ]);
}

/** 오늘 하루의 날씨를 요약하고, 우산/빨래 여부를 판단한다. */
export async function getTodayWeather(): Promise<WeatherSummary> {
  const { dateKey } = getTodayRange();
  return summarizeDay(await fetchTodayForecastItems(dateKey), dateKey);
}

/** 내일 하루의 날씨를 요약하고, 우산/빨래 여부를 판단한다. */
export async function getTomorrowWeather(): Promise<WeatherSummary> {
  const { dateKey } = getTodayRange();
  return summarizeDay(await fetchTomorrowForecastItems(dateKey), addDaysToDateKey(dateKey, 1));
}

/** 예보 항목들 중 dateKey 하루치만 골라 기온/강수를 요약하고 우산/빨래 여부를 판단한다. */
function summarizeDay(items: ForecastItem[], dateKey: string): WeatherSummary {
  const config = loadConfig();
  // 응답에는 며칠치 예보가 섞여 있으므로 해당 날짜 항목만 남긴다.
  const todays = items.filter((it) => it.fcstDate === dateKey.replace(/-/g, ""));

  let maxPop = 0;
  let hasPrecipitation = false;
  let minTemp: number | null = null;
  let maxTemp: number | null = null;
  const tmpValues: number[] = [];

  // 기상청 카테고리 코드: POP=강수확률(%), PTY=강수형태(0=없음, 그 외=비/눈/소나기 등),
  // TMN/TMX=오늘의 최저/최고기온(특정 시간대에만 존재), TMP=매 시간대 기온.
  for (const it of todays) {
    const value = Number(it.fcstValue);
    switch (it.category) {
      case "POP":
        maxPop = Math.max(maxPop, value); // 하루 중 가장 높은 강수확률을 대표값으로 쓴다.
        break;
      case "PTY":
        if (value !== 0) hasPrecipitation = true; // 시간대 하나라도 강수 예보가 있으면 true.
        break;
      case "TMN":
        minTemp = value;
        break;
      case "TMX":
        maxTemp = value;
        break;
      case "TMP":
        tmpValues.push(value);
        break;
    }
  }

  // TMN/TMX가 응답에 없는 경우(발표 시각에 따라 빠질 수 있음)를 대비해 TMP 값들로 대체 계산한다.
  if (minTemp === null && tmpValues.length > 0) minTemp = Math.min(...tmpValues);
  if (maxTemp === null && tmpValues.length > 0) maxTemp = Math.max(...tmpValues);

  return {
    minTemp,
    maxTemp,
    maxPop,
    hasPrecipitation,
    precipitationPeriods: buildPrecipitationPeriods(todays),
    // 강수 예보가 있거나 강수확률이 기준(기본 50%) 이상이면 우산을 챙기라고 안내한다.
    umbrella: hasPrecipitation || maxPop >= config.UMBRELLA_POP_THRESHOLD,
    // 강수 예보가 없고 강수확률이 기준(기본 30%) 미만일 때만 빨래를 널어도 된다고 안내한다.
    laundryOk: !hasPrecipitation && maxPop < config.LAUNDRY_POP_THRESHOLD,
  };
}
