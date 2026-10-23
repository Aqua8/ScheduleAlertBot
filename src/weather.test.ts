import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMidDays } from "./weather.js";
import { formatWeekWeather } from "./format.js";

const thresholds = { umbrella: 50, laundry: 30 };

test("buildMidDays: 4~7일은 오전/오후 중 큰 강수확률, 8일부터는 단일 값", () => {
  const ta = { taMin4: 8, taMax4: 16, taMin8: 5, taMax8: 12 };
  const land = { rnSt4Am: 20, rnSt4Pm: 60, wf4Am: "맑음", wf4Pm: "구름많고 비", rnSt8: 10, wf8: "맑음" };
  const days = buildMidDays(ta, land, "2026-10-24", thresholds);
  assert.deepEqual(days.get("2026-10-28"), {
    minTemp: 8, maxTemp: 16, maxPop: 60, hasPrecipitation: true,
    precipitationPeriods: [], umbrella: true, laundryOk: false,
  });
  assert.equal(days.get("2026-11-01")?.maxPop, 10);
  assert.equal(days.get("2026-11-01")?.laundryOk, true);
  assert.equal(days.has("2026-10-29"), false); // 데이터가 없는 날은 건너뛴다
});

test("formatWeekWeather: 예보 없는 날은 '예보 없음'", () => {
  const days = buildMidDays({ taMin4: 8, taMax4: 16 }, { rnSt4Am: 20, rnSt4Pm: 60, wf4Am: "맑음", wf4Pm: "비" }, "2026-10-24", thresholds);
  const text = formatWeekWeather([
    { dateKey: "2026-10-27", summary: null },
    { dateKey: "2026-10-28", summary: days.get("2026-10-28") ?? null },
  ]);
  assert.equal(text, "📅 주간 날씨\n10/27(화) 예보 없음\n10/28(수) 🌧️ 8°~16° · 강수 60% ☔");
});
