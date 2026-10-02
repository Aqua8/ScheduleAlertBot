// 메신저(Discord, 그리고 2단계에서 추가될 카카오톡 등)를 추상화하는 인터페이스.
// scheduler.ts는 이 인터페이스만 알고 있으면 되므로, 나중에 카카오톡 notifier를 추가해도
// scheduler.ts는 거의 건드릴 필요가 없다 (notifiers 배열에 추가만 하면 됨).
import type { DailySummary } from "../format.js";
import type { WeatherSummary } from "../weather.js";

export interface Notifier {
  /** 06:00 아침 발송. weather가 있으면 함께 보여준다. 이후 수정에 필요한 참조(예: 메시지 id)를 반환할 수 있다. */
  sendDaily(summary: DailySummary, weather?: WeatherSummary): Promise<{ messageId?: string }>;

  /** 수정/갱신 대상이 아닌 일회성 텍스트 발송 (저녁 내일 미리보기 등). */
  sendText(text: string): Promise<void>;

  /**
   * 오늘 일정 변경 감지 시 호출.
   * Discord처럼 수정이 가능하면 messageId를 이용해 edit, 카카오처럼 불가능하면 전체 재발송.
   */
  sendUpdate(
    summary: DailySummary,
    previousEventIds: Set<string>,
    context: { messageId?: string },
  ): Promise<{ messageId?: string }>;
}
