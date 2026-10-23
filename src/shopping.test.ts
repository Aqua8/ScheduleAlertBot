import assert from "node:assert/strict";
import { test } from "node:test";
import { findShoppingItem, findShoppingItems, formatShoppingList, parseShoppingItems } from "./shopping.js";

test("parseShoppingItems: 쉼표/줄바꿈으로 나누고 공백·빈 항목은 버린다", () => {
  assert.deepEqual(parseShoppingItems("우유, 계란,\n두부 ,, "), ["우유", "계란", "두부"]);
  assert.deepEqual(parseShoppingItems("  "), []);
});

test("findShoppingItem: 번호로 찾기", () => {
  const items = ["우유", "계란", "두부"];
  assert.deepEqual(findShoppingItem(items, "2"), { index: 1 });
  assert.deepEqual(findShoppingItem(items, "0"), { error: "0번 항목이 없습니다." });
  assert.deepEqual(findShoppingItem(items, "4"), { error: "4번 항목이 없습니다." });
});

test("findShoppingItem: 이름 일부로 찾기 (0개/1개/여러 개)", () => {
  const items = ["우유", "딸기우유", "계란"];
  assert.deepEqual(findShoppingItem(items, "계"), { index: 2 });
  assert.deepEqual(findShoppingItem(items, "빵"), { error: `"빵"에 해당하는 항목을 찾지 못했습니다.` });
  const many = findShoppingItem(items, "우유");
  assert.ok("error" in many && many.error.includes("1. 우유\n2. 딸기우유"));
});

test("formatShoppingList: 부분 목록도 원래 번호를 유지한다", () => {
  assert.equal(formatShoppingList(["우유", "계란", "두부"]), "1. 우유\n2. 계란\n3. 두부");
  assert.equal(formatShoppingList(["우유", "계란", "두부"], [1, 2]), "2. 계란\n3. 두부");
});

test("findShoppingItems: 번호·이름을 섞어 여러 개 찾고, 중복은 합치며, 하나라도 실패하면 에러", () => {
  const items = ["우유", "계란", "두부", "빵"];
  assert.deepEqual(findShoppingItems(items, "4, 1, 계란, 1"), { indexes: [0, 1, 3] });
  assert.deepEqual(findShoppingItems(items, "1, 9"), { error: "9번 항목이 없습니다." });
  assert.deepEqual(findShoppingItems(items, " , "), { error: "삭제할 항목을 입력해주세요." });
});

test("findShoppingItems: 전부/모두/전체는 모든 항목, 빈 목록은 에러", () => {
  const items = ["우유", "계란"];
  for (const word of ["전부", "모두", "전체"]) assert.deepEqual(findShoppingItems(items, word), { indexes: [0, 1] });
  assert.deepEqual(findShoppingItems([], "전부"), { error: "지울 항목이 없습니다." });
});
