// "오늘 06:00에 이미 발송했는지", "마지막으로 보낸 일정 목록이 무엇인지"를 파일(data/state.json)에
// 기록해두는 모듈. 프로세스가 재시작돼도(launchd 재기동 등) 상태가 유지되어야 캐치업/중복발송 방지가 가능하다.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.js";

export interface DailyState {
  /** YYYY-MM-DD, 어느 날짜에 대한 상태인지 */
  dateKey: string;
  /** 마지막으로 발송/수정한 시점의 이벤트 목록 해시 */
  lastHash: string;
  /** 마지막으로 발송/수정한 시점의 이벤트 id 목록 (신규 항목 판별용) */
  eventIds: string[];
  /** 06:00 아침 발송 시 만들어진 Discord 메시지 id (수정 대상) */
  discordMessageId?: string;
  /** 오늘 06:00 발송을 이미 했는지 */
  dailySent: boolean;
}

const STATE_PATH = fileURLToPath(new URL("state.json", DATA_DIR));

/** 저장된 상태를 읽는다. 파일이 아직 없으면(최초 실행 등) null을 반환한다. */
export async function loadState(): Promise<DailyState | null> {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw) as DailyState;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** 상태를 파일에 덮어쓴다. 06:00 발송 직후, 그리고 폴링으로 변경을 감지해 재발송할 때마다 호출된다. */
export async function saveState(state: DailyState): Promise<void> {
  await mkdir(fileURLToPath(DATA_DIR), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

/** 이벤트 목록으로부터 변경 감지용 해시를 만든다. id/제목/시간/위치가 바뀌면 값이 달라진다. */
export function hashEvents(events: { id: string; title: string; start: string; end: string; location?: string }[]): string {
  const normalized = events
    .map((e) => `${e.id}|${e.title}|${e.start}|${e.end}|${e.location ?? ""}`)
    .sort()
    .join("\n");
  // 외부 의존성 없이 간단한 문자열 해시 (충돌 걱정 없는 용도)
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (Math.imul(31, hash) + normalized.charCodeAt(i)) | 0;
  }
  return `${hash}:${normalized.length}`;
}
