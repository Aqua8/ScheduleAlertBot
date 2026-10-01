// `/할일수정`, `/할일삭제`가 "어떤 할 일을 말하는지"를 자연어로부터 찾아내는 모듈.
// eventParser의 parseSearchIntent로 키워드/날짜범위를 뽑은 뒤, 미완료 할 일 중에서 걸러낸다.
import { listTasks } from "./calendar.js";
import type { TaskItem } from "./calendar.js";
import { parseSearchIntent } from "./eventParser.js";

/**
 * 자연어 설명("test", "내일까지 보고서")으로 미완료 할 일을 찾는다.
 * 날짜가 언급되면 그 범위에 마감인 것만, 아니면 마감일과 무관하게 전체에서 찾는다.
 */
export async function findMatchingTasks(text: string): Promise<TaskItem[]> {
  const intent = await parseSearchIntent(text);
  const dateFrom = intent.dateFrom;
  const dateTo = intent.dateTo ?? intent.dateFrom;

  const tasks = await listTasks(dateFrom && dateTo ? { dateFrom, dateTo } : undefined);
  const keyword = intent.keyword?.toLowerCase();
  return keyword ? tasks.filter((t) => t.title.toLowerCase().includes(keyword)) : tasks;
}
