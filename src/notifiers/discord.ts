// Discord 봇 구현체. 크게 두 역할을 한다:
//   1) discordNotifier — scheduler.ts가 호출하는 Notifier 구현 (06:00 발송 / 변경 시 메시지 수정)
//   2) 슬래시 명령어 12종의 핸들러 — 사용자가 직접 캘린더/날씨를 조회·조작할 때 쓰는 대화형 인터페이스
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  DMChannel,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { noteAction, noteCancelled, noteFailure, runLogged } from "../commandLog.js";
import { loadConfig, requireDiscordConfig } from "../config.js";
import {
  formatDailySummary,
  formatUpdatedSummary,
  formatEventBrief,
  formatEventList,
  formatEventCandidates,
  formatWeatherLine,
  formatTaskBrief,
  formatTaskCandidates,
  formatFreeSlots,
} from "../format.js";
import type { Notifier } from "./types.js";
import type { DailySummary } from "../format.js";
import type { WeatherSummary } from "../weather.js";
import { getTodayEvents, getTodayTasks, getOverdueTasks, getEvent, findConflictingEvents, completeTask, createTask, updateTask, deleteTask, createEvent, updateEvent, deleteEvent, listEvents, dateRangeToISO, addDaysToDateKey } from "../calendar.js";
import { getTodayRange } from "../calendar.js";
import { parseEventText, parseEventUpdate, parseSearchIntent, parseTaskText, parseTaskUpdate, parseAssistantRequest } from "../eventParser.js";
import { findMatchingEvents } from "../eventSearch.js";
import { findMatchingTasks } from "../taskSearch.js";
import { findFreeSlots, MAX_FREE_TIME_DAYS } from "../freeTime.js";
import { getTodayWeather } from "../weather.js";

let client: Client | null = null;
let ready: Promise<Client> | null = null;

/** Discord Gateway에 로그인하고, /오늘일정 명령어를 처리하는 리스너를 등록한다. 앱 시작 시 1회 호출. */
export function startDiscordClient(): Promise<Client> {
  if (ready) return ready;

  const config = loadConfig();
  requireDiscordConfig(config);
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    // 어떤 명령을 썼는지, 성공/실패/취소를 로그 한 줄로 남긴다 (입력한 내용은 남기지 않는다).
    const run = (handle: (i: ChatInputCommandInteraction) => Promise<unknown>) => runLogged(interaction, () => handle(interaction));
    switch (interaction.commandName) {
      case "오늘일정":
        return run(handleTodayCommand);
      case "일정추가":
        return run(handleAddEventCommand);
      case "일정목록":
        return run(handleListCommand);
      case "일정수정":
        return run(handleEditCommand);
      case "일정삭제":
        return run(handleDeleteCommand);
      case "오늘날씨":
        return run(handleWeatherCommand);
      case "할일추가":
        return run(handleAddTaskCommand);
      case "할일수정":
        return run(handleEditTaskCommand);
      case "할일삭제":
        return run(handleDeleteTaskCommand);
      case "할일완료":
        return run(handleCompleteTaskCommand);
      case "빈시간":
        return run(handleFreeTimeCommand);
      case "비서":
        return run(handleAssistantCommand);
    }
  });

  ready = new Promise((resolve, reject) => {
    client!.once("clientReady", () => resolve(client!));
    client!.once("error", reject);
    client!.login(config.DISCORD_BOT_TOKEN).catch(reject);
  });

  return ready;
}

async function handleTodayCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const events = await getTodayEvents();
    const tasks = await getTodayTasks().catch(() => undefined); // 권한 미승인 시 할 일 없이 표시
    const overdueTasks = await getOverdueTasks().catch(() => undefined);
    const { dateKey } = getTodayRange();
    const text = formatDailySummary({ dateKey, events, tasks, overdueTasks });
    await interaction.editReply(text);
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`일정을 불러오지 못했습니다: ${(err as Error).message}`);
  }
}

async function handleWeatherCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const weather = await getTodayWeather();
    await interaction.editReply(formatWeatherLine(weather));
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`날씨 정보를 가져오지 못했습니다: ${(err as Error).message}`);
  }
}

/** `/일정추가` — 자연어 문장을 파싱해 바로 캘린더에 등록한다. 확인 절차 없이 즉시 등록(캘린더가 항상 정답인 구조). */
async function handleAddEventCommand(interaction: ChatInputCommandInteraction) {
  const text = interaction.options.getString("내용", true);
  await interaction.deferReply(); // 등록은 다른 사람도 보게(공개) 응답한다.
  await runAddEvent(interaction, text);
}

/** /일정추가 처리 본문. 이미 deferReply 된 interaction에 답한다(`/비서`에서도 재사용). */
async function runAddEvent(interaction: ChatInputCommandInteraction, text: string) {
  try {
    const parsed = await parseEventText(text);
    // 겹침 경고는 부가 기능이라, 조회에 실패해도 등록은 그대로 진행한다. 등록하기 전에 조회해야 방금 만든 일정이 섞이지 않는다.
    const conflicts = await findConflictingEvents(parsed).catch(() => []);
    const created = await createEvent(parsed);
    const warning = conflicts.length > 0 ? `\n\n⚠️ 시간이 겹치는 일정이 있어요\n${formatEventCandidates(conflicts)}` : "";
    await interaction.editReply(`✅ 일정을 등록했습니다\n${formatEventBrief(created)}${warning}`);
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`일정 등록에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/일정목록` — 기간을 지정하면 그 기간의 일정을, 생략하면 오늘부터 7일치를 조회한다. */
async function handleListCommand(interaction: ChatInputCommandInteraction) {
  const periodText = interaction.options.getString("기간");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await runList(interaction, periodText);
}

/** /일정목록 처리 본문. 이미 deferReply 된 interaction에 답한다(`/비서`에서도 재사용). */
async function runList(interaction: ChatInputCommandInteraction, periodText: string | null) {
  try {
    const { dateKey: today } = getTodayRange();
    let dateFrom = today;
    let dateTo = addDaysToDateKey(today, 7); // 기간 미입력 시 기본값

    if (periodText) {
      // "이번주" 같은 자연어를 실제 날짜 범위로 변환한다. 검색과 같은 파서를 재사용.
      const intent = await parseSearchIntent(periodText);
      dateFrom = intent.dateFrom ?? today;
      dateTo = intent.dateTo ?? intent.dateFrom ?? addDaysToDateKey(today, 7);
    }

    const { timeMin, timeMax } = dateRangeToISO(dateFrom, dateTo);
    const events = await listEvents(timeMin, timeMax);
    await interaction.editReply(formatEventList(dateFrom, dateTo, events));
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`일정 목록을 불러오지 못했습니다: ${(err as Error).message}`);
  }
}

/** 자연어로 일정을 찾는다. 매치가 0개/여러 개면 안내 메시지를 보내고 null을 반환한다. */
async function findSingleEventOrReply(
  interaction: ChatInputCommandInteraction,
  findText: string,
) {
  const matches = await findMatchingEvents(findText);
  if (matches.length === 0) {
    noteFailure(interaction, "대상을 찾지 못함");
    await interaction.editReply(`"${findText}"에 해당하는 일정을 찾지 못했습니다.`);
    return null;
  }
  if (matches.length > 1) {
    noteFailure(interaction, "검색 결과가 여러 개");
    await interaction.editReply(
      `일정이 여러 개 검색되었습니다. 날짜를 더 구체적으로 입력해주세요:\n${formatEventCandidates(matches)}`,
    );
    return null;
  }
  return matches[0];
}

/** 버튼을 보여주고 명령어를 실행한 본인이 누른 버튼을 반환한다. 30초 안에 누르지 않으면 null. */
async function askButtons(
  interaction: ChatInputCommandInteraction,
  content: string,
  buttons: { id: string; label: string; style: ButtonStyle }[],
) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.map((b) => new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(b.style)),
  );
  const reply = await interaction.editReply({ content, components: [row] });
  try {
    return await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: 30_000,
    });
  } catch {
    return null;
  }
}

/** `/일정수정` — 찾기 문장으로 일정을 특정한 뒤, 변경 문장을 반영한 최종 상태로 덮어쓴다. */
async function handleEditCommand(interaction: ChatInputCommandInteraction) {
  const findText = interaction.options.getString("찾기", true);
  const changeText = interaction.options.getString("변경", true);
  await interaction.deferReply();
  await runEditEvent(interaction, findText, changeText);
}

/** /일정수정 처리 본문. 이미 deferReply 된 interaction에 답한다(`/비서`에서도 재사용). */
async function runEditEvent(interaction: ChatInputCommandInteraction, findText: string, changeText: string) {
  try {
    const target = await findSingleEventOrReply(interaction, findText);
    if (!target) return; // 못 찾았거나 여러 개면 이미 안내 메시지를 보냈으므로 여기서 종료.

    // 반복 일정이면 "이번 회차만 / 전체 반복" 중 어디에 적용할지 먼저 묻는다.
    // 전체 반복은 반복 규칙을 가진 원본 일정을 수정한다(시간 등 변경이 모든 회차에 반영됨).
    let editTarget = target;
    let instanceOnly = false;
    if (target.recurringEventId) {
      const button = await askButtons(interaction, `반복 일정입니다. 어디까지 수정할까요?\n${formatEventBrief(target)}`, [
        { id: "scope_instance", label: "이번 회차만", style: ButtonStyle.Primary },
        { id: "scope_series", label: "전체 반복", style: ButtonStyle.Primary },
        { id: "scope_cancel", label: "취소", style: ButtonStyle.Secondary },
      ]);
      if (!button) {
        noteCancelled(interaction, "시간 초과");
        await interaction.editReply({ content: "응답 시간이 초과되어 수정을 취소했습니다.", components: [] });
        return;
      }
      if (button.customId === "scope_cancel") {
        noteCancelled(interaction, "사용자가 취소");
        await button.update({ content: "수정을 취소했습니다.", components: [] });
        return;
      }
      await button.deferUpdate(); // 이후 파싱/수정이 3초를 넘길 수 있어 먼저 응답을 확보한다.
      if (button.customId === "scope_series") editTarget = await getEvent(target.recurringEventId);
      else instanceOnly = true;
    }

    // "언급 안 된 필드는 기존 값 유지"한 최종 일정 정보를 만들어 그대로 덮어쓴다.
    const updatedInput = await parseEventUpdate(editTarget, changeText);
    // 한 회차는 자체 반복 규칙을 가질 수 없고, 전체 반복에서 규칙 변경 언급이 없으면(null) 기존 규칙을 유지한다.
    const recurrence = instanceOnly ? undefined : (updatedInput.recurrence ?? editTarget.recurrence);
    const updated = await updateEvent(editTarget.id, { ...updatedInput, recurrence });
    await interaction.editReply({ content: `✏️ 일정을 수정했습니다\n${formatEventBrief(updated)}`, components: [] });
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`일정 수정에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/일정삭제` — 일정을 특정한 뒤 삭제/취소 버튼으로 한 번 확인받고서야 실제로 삭제한다 (되돌릴 수 없는 작업이라 등록/수정과 다름). */
async function handleDeleteCommand(interaction: ChatInputCommandInteraction) {
  const findText = interaction.options.getString("찾기", true);
  await interaction.deferReply();
  await runDeleteEvent(interaction, findText);
}

/** /일정삭제 처리 본문. 이미 deferReply 된 interaction에 답한다(`/비서`에서도 재사용). */
async function runDeleteEvent(interaction: ChatInputCommandInteraction, findText: string) {
  try {
    const target = await findSingleEventOrReply(interaction, findText);
    if (!target) return;

    // 반복 일정이면 "이번 회차만 / 전체 반복" 삭제 버튼이 곧 확인 절차를 겸한다.
    if (target.recurringEventId) {
      const button = await askButtons(interaction, `반복 일정입니다. 어떻게 삭제할까요?\n${formatEventBrief(target)}`, [
        { id: "scope_instance", label: "이번 회차만 삭제", style: ButtonStyle.Danger },
        { id: "scope_series", label: "전체 반복 삭제", style: ButtonStyle.Danger },
        { id: "scope_cancel", label: "취소", style: ButtonStyle.Secondary },
      ]);
      if (!button) {
        noteCancelled(interaction, "시간 초과");
        await interaction.editReply({ content: "응답 시간이 초과되어 삭제를 취소했습니다.", components: [] });
      } else if (button.customId === "scope_cancel") {
        noteCancelled(interaction, "사용자가 취소");
        await button.update({ content: "삭제를 취소했습니다.", components: [] });
      } else {
        const series = button.customId === "scope_series";
        await deleteEvent(series ? target.recurringEventId : target.id);
        await button.update({
          content: `🗑️ ${series ? "반복 일정 전체를" : "이번 회차를"} 삭제했습니다\n${formatEventBrief(target)}`,
          components: [],
        });
      }
      return;
    }

    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("delete_confirm").setLabel("삭제").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("delete_cancel").setLabel("취소").setStyle(ButtonStyle.Secondary),
    );
    const reply = await interaction.editReply({
      content: `다음 일정을 삭제할까요?\n${formatEventBrief(target)}`,
      components: [confirmRow],
    });

    try {
      // 명령어를 실행한 본인만 버튼을 누를 수 있게 제한하고, 30초 안에 응답이 없으면 아래 catch로 넘어가 자동 취소된다.
      const button = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === interaction.user.id,
        time: 30_000,
      });
      if (button.customId === "delete_confirm") {
        await deleteEvent(target.id);
        await button.update({ content: `🗑️ 일정을 삭제했습니다\n${formatEventBrief(target)}`, components: [] });
      } else {
        noteCancelled(interaction, "사용자가 취소");
        await button.update({ content: "삭제를 취소했습니다.", components: [] });
      }
    } catch {
      // awaitMessageComponent가 타임아웃되면 예외를 던지는데, 이 경우가 "30초 무응답"에 해당한다.
      noteCancelled(interaction, "시간 초과");
      await interaction.editReply({ content: "응답 시간이 초과되어 삭제를 취소했습니다.", components: [] });
    }
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`일정 삭제 처리에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/할일추가` — 자연어 문장을 파싱해 기본 할 일 목록에 바로 등록한다. */
async function handleAddTaskCommand(interaction: ChatInputCommandInteraction) {
  const text = interaction.options.getString("내용", true);
  await interaction.deferReply();
  await runAddTask(interaction, text);
}

/** /할일추가 처리 본문. 이미 deferReply 된 interaction에 답한다(`/비서`에서도 재사용). */
async function runAddTask(interaction: ChatInputCommandInteraction, text: string) {
  try {
    const parsed = await parseTaskText(text);
    const created = await createTask(parsed);
    await interaction.editReply(`✅ 할 일을 등록했습니다\n${formatTaskBrief(created)}`);
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`할 일 등록에 실패했습니다: ${(err as Error).message}`);
  }
}

/** 자연어로 할 일을 찾는다. 매치가 0개/여러 개면 안내 메시지를 보내고 null을 반환한다. */
async function findSingleTaskOrReply(interaction: ChatInputCommandInteraction, findText: string) {
  const matches = await findMatchingTasks(findText);
  if (matches.length === 0) {
    noteFailure(interaction, "대상을 찾지 못함");
    await interaction.editReply(`"${findText}"에 해당하는 할 일을 찾지 못했습니다.`);
    return null;
  }
  if (matches.length > 1) {
    noteFailure(interaction, "검색 결과가 여러 개");
    await interaction.editReply(
      `할 일이 여러 개 검색되었습니다. 더 구체적으로 입력해주세요:\n${formatTaskCandidates(matches)}`,
    );
    return null;
  }
  return matches[0];
}

/** `/할일수정` — 찾기 문장으로 할 일을 특정한 뒤, 변경 문장을 반영한 최종 상태로 바꾼다. */
async function handleEditTaskCommand(interaction: ChatInputCommandInteraction) {
  const findText = interaction.options.getString("찾기", true);
  const changeText = interaction.options.getString("변경", true);
  await interaction.deferReply();
  await runEditTask(interaction, findText, changeText);
}

/** /할일수정 처리 본문. 이미 deferReply 된 interaction에 답한다(`/비서`에서도 재사용). */
async function runEditTask(interaction: ChatInputCommandInteraction, findText: string, changeText: string) {
  try {
    const target = await findSingleTaskOrReply(interaction, findText);
    if (!target) return;

    const updatedInput = await parseTaskUpdate(target, changeText);
    const updated = await updateTask(target, updatedInput);
    await interaction.editReply(`✏️ 할 일을 수정했습니다\n${formatTaskBrief(updated)}`);
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`할 일 수정에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/할일완료` — 할 일을 특정해 완료 처리한다. 삭제와 달리 Google Tasks에서 되돌릴 수 있어 확인 절차 없이 바로 처리한다. */
async function handleCompleteTaskCommand(interaction: ChatInputCommandInteraction) {
  const findText = interaction.options.getString("찾기", true);
  await interaction.deferReply();
  await runCompleteTask(interaction, findText);
}

/** /할일완료 처리 본문. 이미 deferReply 된 interaction에 답한다(`/비서`에서도 재사용). */
async function runCompleteTask(interaction: ChatInputCommandInteraction, findText: string) {
  try {
    const target = await findSingleTaskOrReply(interaction, findText);
    if (!target) return;

    await completeTask(target);
    await interaction.editReply(`✅ 할 일을 완료 처리했습니다\n${formatTaskBrief(target)}`);
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`할 일 완료 처리에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/할일삭제` — 할 일을 특정한 뒤 삭제/취소 버튼으로 한 번 확인받고서야 실제로 삭제한다. */
async function handleDeleteTaskCommand(interaction: ChatInputCommandInteraction) {
  const findText = interaction.options.getString("찾기", true);
  await interaction.deferReply();
  await runDeleteTask(interaction, findText);
}

/** /할일삭제 처리 본문. 이미 deferReply 된 interaction에 답한다(`/비서`에서도 재사용). */
async function runDeleteTask(interaction: ChatInputCommandInteraction, findText: string) {
  try {
    const target = await findSingleTaskOrReply(interaction, findText);
    if (!target) return;

    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("delete_confirm").setLabel("삭제").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("delete_cancel").setLabel("취소").setStyle(ButtonStyle.Secondary),
    );
    const reply = await interaction.editReply({
      content: `다음 할 일을 삭제할까요?\n${formatTaskBrief(target)}`,
      components: [confirmRow],
    });

    try {
      const button = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === interaction.user.id,
        time: 30_000,
      });
      if (button.customId === "delete_confirm") {
        await deleteTask(target);
        await button.update({ content: `🗑️ 할 일을 삭제했습니다\n${formatTaskBrief(target)}`, components: [] });
      } else {
        noteCancelled(interaction, "사용자가 취소");
        await button.update({ content: "삭제를 취소했습니다.", components: [] });
      }
    } catch {
      noteCancelled(interaction, "시간 초과");
      await interaction.editReply({ content: "응답 시간이 초과되어 삭제를 취소했습니다.", components: [] });
    }
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`할 일 삭제 처리에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/빈시간` — 기간(기본 오늘부터 7일) 안에서 09:00~18:00 중 일정이 없는 구간을 알려준다. */
async function handleFreeTimeCommand(interaction: ChatInputCommandInteraction) {
  const periodText = interaction.options.getString("기간");
  const minutes = interaction.options.getInteger("길이") ?? 60;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { dateKey: today } = getTodayRange();
    let dateFrom = today;
    let dateTo = addDaysToDateKey(today, 6);

    if (periodText) {
      const intent = await parseSearchIntent(periodText);
      dateFrom = intent.dateFrom ?? today;
      dateTo = intent.dateTo ?? intent.dateFrom ?? addDaysToDateKey(today, 6);
    }

    // 일정 조회가 최대 50건이라 기간이 길면 결과가 부정확해진다. 최대 일수까지만 보고 안내한다.
    const lastAllowed = addDaysToDateKey(dateFrom, MAX_FREE_TIME_DAYS - 1);
    const clamped = dateTo > lastAllowed;
    if (clamped) dateTo = lastAllowed;

    const { slots, truncated } = await findFreeSlots(dateFrom, dateTo, minutes);
    const note = clamped ? `_(최대 ${MAX_FREE_TIME_DAYS}일까지만 조회해요)_\n` : "";
    await interaction.editReply(`${note}${formatFreeSlots(dateFrom, dateTo, minutes, slots, truncated)}`);
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`빈 시간을 찾지 못했습니다: ${(err as Error).message}`);
  }
}

/**
 * `/비서` — 자유로운 한 문장을 어떤 작업인지 분류한 뒤, 기존 명령어의 처리 로직에 그대로 넘긴다.
 * 삭제는 기존 명령어와 같이 확인 버튼을 거친다. 한 번에 한 가지 작업만 처리한다(한 메시지를 여러 작업이 고쳐 쓰면 서로 덮어쓰기 때문).
 */
const ASSISTANT_ACTION_LABEL = {
  add_event: "일정추가",
  edit_event: "일정수정",
  delete_event: "일정삭제",
  list_events: "일정목록",
  add_task: "할일추가",
  edit_task: "할일수정",
  delete_task: "할일삭제",
  complete_task: "할일완료",
} as const;

async function handleAssistantCommand(interaction: ChatInputCommandInteraction) {
  const text = interaction.options.getString("내용", true);
  await interaction.deferReply();
  try {
    const req = await parseAssistantRequest(text);
    const actionLabel = (ASSISTANT_ACTION_LABEL as Record<string, string | undefined>)[req.action];
    if (actionLabel) noteAction(interaction, actionLabel); // 문장 내용이 아니라 어떤 동작으로 해석됐는지만 남긴다.
    if (req.multiple) {
      noteFailure(interaction, "여러 작업을 한 번에 요청");
      await interaction.editReply("한 번에 한 가지 작업만 처리할 수 있어요. 나눠서 요청해주세요.");
      return;
    }

    switch (req.action) {
      case "add_event":
        if (req.content) return await runAddEvent(interaction, req.content);
        break;
      case "edit_event":
        if (req.find && req.change) return await runEditEvent(interaction, req.find, req.change);
        break;
      case "delete_event":
        if (req.find) return await runDeleteEvent(interaction, req.find);
        break;
      case "list_events":
        return await runList(interaction, req.period ?? null);
      case "add_task":
        if (req.content) return await runAddTask(interaction, req.content);
        break;
      case "edit_task":
        if (req.find && req.change) return await runEditTask(interaction, req.find, req.change);
        break;
      case "delete_task":
        if (req.find) return await runDeleteTask(interaction, req.find);
        break;
      case "complete_task":
        if (req.find) return await runCompleteTask(interaction, req.find);
        break;
    }
    noteFailure(interaction, "요청을 이해하지 못함");
    await interaction.editReply(
      "무엇을 할지 이해하지 못했어요. 예: `내일 3시 치과 잡아줘`, `보고서 할 일 추가해줘`, `test 할 일 지워줘`, `이번주 일정 알려줘`",
    );
  } catch (err) {
    noteFailure(interaction, err);
    await interaction.editReply(`요청을 처리하지 못했습니다: ${(err as Error).message}`);
  }
}

/** .env 설정(channel/dm)에 따라 06:00 발송·수정 메시지를 보낼 대상 채널(또는 DM)을 가져온다. */
async function resolveTargetChannel(): Promise<TextChannel | DMChannel> {
  const config = loadConfig();
  requireDiscordConfig(config);
  const c = await startDiscordClient();

  if (config.DISCORD_TARGET_TYPE === "dm") {
    const user = await c.users.fetch(config.DISCORD_TARGET_ID);
    return await user.createDM();
  }

  const channel = await c.channels.fetch(config.DISCORD_TARGET_ID);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error(`DISCORD_TARGET_ID(${config.DISCORD_TARGET_ID})가 텍스트 채널이 아닙니다.`);
  }
  return channel as TextChannel;
}

// scheduler.ts가 실제로 사용하는 Notifier 구현. Discord 특유의 "메시지 수정" 기능을 활용해
// sendUpdate에서 기존 메시지를 그대로 고쳐 쓴다(카카오톡처럼 재발송이 아님).
export const discordNotifier: Notifier = {
  /** 06:00 최초 발송. 이후 sendUpdate에서 고쳐 쓸 수 있도록 messageId를 반환한다. */
  async sendDaily(summary: DailySummary, weather?: WeatherSummary) {
    const channel = await resolveTargetChannel();
    const message = await channel.send(formatDailySummary(summary, weather));
    return { messageId: message.id };
  },

  /** 저녁 내일 미리보기처럼 수정할 일 없는 일회성 메시지를 발송한다. */
  async sendText(text: string) {
    const channel = await resolveTargetChannel();
    await channel.send(text);
  },

  /** 일정 변경 감지 시 호출. 아침 메시지를 찾아 수정하고, 못 찾으면(삭제 등) 새로 보낸다. */
  async sendUpdate(summary, previousEventIds, context) {
    const channel = await resolveTargetChannel();
    const text = formatUpdatedSummary(summary, previousEventIds, new Date());

    if (context.messageId) {
      try {
        const message = await channel.messages.fetch(context.messageId);
        await message.edit(text);
        return { messageId: message.id };
      } catch {
        // 원본 메시지를 못 찾으면(삭제됨 등) 새로 보낸다.
      }
    }
    const message = await channel.send(text);
    return { messageId: message.id };
  },
};

/** 슬래시 명령어 등록에 사용하는 정의들. scripts/register-commands.ts 에서 재사용. */
export const todayCommand = new SlashCommandBuilder()
  .setName("오늘일정")
  .setDescription("오늘 캘린더 일정을 즉시 조회합니다");

export const addEventCommand = new SlashCommandBuilder()
  .setName("일정추가")
  .setDescription("자연어 문장으로 캘린더에 일정을 추가합니다")
  .addStringOption((option) =>
    option.setName("내용").setDescription("예: 다음주 화요일 2시 치과, 매주 화요일 7시 운동").setRequired(true),
  );

export const listCommand = new SlashCommandBuilder()
  .setName("일정목록")
  .setDescription("기간을 지정해 캘린더 일정을 조회합니다 (기본: 오늘부터 7일)")
  .addStringOption((option) =>
    option.setName("기간").setDescription("예: 이번주, 다음달 1일부터 10일까지").setRequired(false),
  );

export const editCommand = new SlashCommandBuilder()
  .setName("일정수정")
  .setDescription("자연어로 기존 일정을 찾아 수정합니다")
  .addStringOption((option) => option.setName("찾기").setDescription("예: 내일 치과").setRequired(true))
  .addStringOption((option) =>
    option.setName("변경").setDescription("예: 3시로 변경, 장소를 강남으로").setRequired(true),
  );

export const deleteCommand = new SlashCommandBuilder()
  .setName("일정삭제")
  .setDescription("자연어로 기존 일정을 찾아 삭제합니다 (삭제 전 확인)")
  .addStringOption((option) => option.setName("찾기").setDescription("예: 내일 치과").setRequired(true));

export const weatherCommand = new SlashCommandBuilder()
  .setName("오늘날씨")
  .setDescription("오늘 날씨와 우산/빨래 여부를 확인합니다");

export const addTaskCommand = new SlashCommandBuilder()
  .setName("할일추가")
  .setDescription("자연어 문장으로 할 일을 추가합니다")
  .addStringOption((option) =>
    option.setName("내용").setDescription("예: 내일까지 보고서 제출").setRequired(true),
  );

export const editTaskCommand = new SlashCommandBuilder()
  .setName("할일수정")
  .setDescription("자연어로 기존 할 일을 찾아 수정합니다")
  .addStringOption((option) => option.setName("찾기").setDescription("예: 보고서").setRequired(true))
  .addStringOption((option) =>
    option.setName("변경").setDescription("예: 금요일로 변경, 제목을 보고서 검토로").setRequired(true),
  );

export const deleteTaskCommand = new SlashCommandBuilder()
  .setName("할일삭제")
  .setDescription("자연어로 기존 할 일을 찾아 삭제합니다 (삭제 전 확인)")
  .addStringOption((option) => option.setName("찾기").setDescription("예: 보고서").setRequired(true));

export const completeTaskCommand = new SlashCommandBuilder()
  .setName("할일완료")
  .setDescription("자연어로 기존 할 일을 찾아 완료 처리합니다")
  .addStringOption((option) => option.setName("찾기").setDescription("예: 보고서").setRequired(true));

export const freeTimeCommand = new SlashCommandBuilder()
  .setName("빈시간")
  .setDescription("기간 안에서 일정이 없는 빈 시간(09:00~18:00)을 찾습니다")
  .addStringOption((option) =>
    option.setName("기간").setDescription("예: 이번주, 다음주 (기본: 오늘부터 7일, 최대 14일)").setRequired(false),
  )
  .addIntegerOption((option) =>
    option.setName("길이").setDescription("필요한 시간(분). 기본 60").setMinValue(15).setMaxValue(480).setRequired(false),
  );

export const assistantCommand = new SlashCommandBuilder()
  .setName("비서")
  .setDescription("자유로운 문장으로 일정/할 일을 등록·수정·삭제·완료·조회합니다")
  .addStringOption((option) =>
    option.setName("내용").setDescription("예: 내일 3시 치과 잡아줘, test 할 일 지워줘").setRequired(true),
  );

/** 봇의 슬래시 명령어 목록을 Discord 서버(전역)에 등록한다. `npm run register-commands`로 1회 실행하면 된다. */
export async function registerCommands(): Promise<void> {
  const config = loadConfig();
  requireDiscordConfig(config);
  const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(config.DISCORD_APPLICATION_ID), {
    body: [
      todayCommand.toJSON(),
      addEventCommand.toJSON(),
      listCommand.toJSON(),
      editCommand.toJSON(),
      deleteCommand.toJSON(),
      weatherCommand.toJSON(),
      addTaskCommand.toJSON(),
      editTaskCommand.toJSON(),
      deleteTaskCommand.toJSON(),
      completeTaskCommand.toJSON(),
      freeTimeCommand.toJSON(),
      assistantCommand.toJSON(),
    ],
  });
}
