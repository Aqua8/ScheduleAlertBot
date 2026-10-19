// `/살것추가` `/살것수정` `/살것삭제` `/살것목록`이 쓰는 "사야 할 것" 목록 모듈.
// 목록은 data/shopping.json에 문자열 배열로 저장한다. 캘린더/Google과 무관해서 claude CLI도 쓰지 않는다.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.js";

const SHOPPING_PATH = fileURLToPath(new URL("shopping.json", DATA_DIR));

/** 저장된 목록을 읽는다. 파일이 아직 없으면 빈 목록. */
export async function loadShoppingList(): Promise<string[]> {
  try {
    return JSON.parse(await readFile(SHOPPING_PATH, "utf-8")) as string[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function saveShoppingList(items: string[]): Promise<void> {
  await mkdir(fileURLToPath(DATA_DIR), { recursive: true });
  await writeFile(SHOPPING_PATH, JSON.stringify(items, null, 2), "utf-8");
}

/** "우유, 계란\n두부"처럼 쉼표/줄바꿈으로 구분된 입력을 항목 배열로 나눈다. */
export function parseShoppingItems(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type ShoppingMatch = { index: number } | { error: string };

/** 번호("2") 또는 이름 일부("계란")로 항목 하나를 찾는다. 0개/여러 개면 사유를 돌려준다. */
export function findShoppingItem(items: string[], query: string): ShoppingMatch {
  const q = query.trim();
  if (/^\d+$/.test(q)) {
    const index = Number(q) - 1;
    return index >= 0 && index < items.length ? { index } : { error: `${q}번 항목이 없습니다.` };
  }
  const lower = q.toLowerCase();
  const matches = items.flatMap((item, index) => (item.toLowerCase().includes(lower) ? [index] : []));
  if (matches.length === 0) return { error: `"${q}"에 해당하는 항목을 찾지 못했습니다.` };
  if (matches.length > 1) {
    return { error: `여러 개가 검색되었습니다. 번호나 더 구체적인 이름으로 입력해주세요:\n${formatShoppingList(items, matches)}` };
  }
  return { index: matches[0] };
}

/** 번호를 붙인 목록 텍스트. indexes를 주면 그 항목만(원래 번호 유지) 보여준다. */
export function formatShoppingList(items: string[], indexes = items.map((_, i) => i)): string {
  return indexes.map((i) => `${i + 1}. ${items[i]}`).join("\n");
}
