// Discord 봇 구현체. 크게 두 역할을 한다:
//   1) discordNotifier — scheduler.ts가 호출하는 Notifier 구현 (06:00 발송 / 변경 시 메시지 수정)
//   2) 슬래시 명령어 9종의 핸들러 — 사용자가 직접 캘린더/날씨를 조회·조작할 때 쓰는 대화형 인터페이스
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
} from "../format.js";
import type { Notifier } from "./types.js";
import type { DailySummary } from "../format.js";
import type { WeatherSummary } from "../weather.js";
import { getTodayEvents, getTodayTasks, createTask, updateTask, deleteTask, createEvent, updateEvent, deleteEvent, listEvents, dateRangeToISO, addDaysToDateKey } from "../calendar.js";
import { getTodayRange } from "../calendar.js";
import { parseEventText, parseEventUpdate, parseSearchIntent, parseTaskText, parseTaskUpdate } from "../eventParser.js";
import { findMatchingEvents } from "../eventSearch.js";
import { findMatchingTasks } from "../taskSearch.js";
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
    switch (interaction.commandName) {
      case "오늘일정":
        return handleTodayCommand(interaction);
      case "일정추가":
        return handleAddEventCommand(interaction);
      case "일정목록":
        return handleListCommand(interaction);
      case "일정수정":
        return handleEditCommand(interaction);
      case "일정삭제":
        return handleDeleteCommand(interaction);
      case "오늘날씨":
        return handleWeatherCommand(interaction);
      case "할일추가":
        return handleAddTaskCommand(interaction);
      case "할일수정":
        return handleEditTaskCommand(interaction);
      case "할일삭제":
        return handleDeleteTaskCommand(interaction);
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
    const { dateKey } = getTodayRange();
    const text = formatDailySummary({ dateKey, events, tasks });
    await interaction.editReply(text);
  } catch (err) {
    await interaction.editReply(`일정을 불러오지 못했습니다: ${(err as Error).message}`);
  }
}

async function handleWeatherCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const weather = await getTodayWeather();
    await interaction.editReply(formatWeatherLine(weather));
  } catch (err) {
    await interaction.editReply(`날씨 정보를 가져오지 못했습니다: ${(err as Error).message}`);
  }
}

/** `/일정추가` — 자연어 문장을 파싱해 바로 캘린더에 등록한다. 확인 절차 없이 즉시 등록(캘린더가 항상 정답인 구조). */
async function handleAddEventCommand(interaction: ChatInputCommandInteraction) {
  const text = interaction.options.getString("내용", true);
  await interaction.deferReply(); // 등록은 다른 사람도 보게(공개) 응답한다.
  try {
    const parsed = await parseEventText(text);
    const created = await createEvent(parsed);
    await interaction.editReply(`✅ 일정을 등록했습니다\n${formatEventBrief(created)}`);
  } catch (err) {
    await interaction.editReply(`일정 등록에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/일정목록` — 기간을 지정하면 그 기간의 일정을, 생략하면 오늘부터 7일치를 조회한다. */
async function handleListCommand(interaction: ChatInputCommandInteraction) {
  const periodText = interaction.options.getString("기간");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    await interaction.editReply(`"${findText}"에 해당하는 일정을 찾지 못했습니다.`);
    return null;
  }
  if (matches.length > 1) {
    await interaction.editReply(
      `일정이 여러 개 찾혔습니다. 날짜를 더 구체적으로 입력해주세요:\n${formatEventCandidates(matches)}`,
    );
    return null;
  }
  return matches[0];
}

/** `/일정수정` — 찾기 문장으로 일정을 특정한 뒤, 변경 문장을 반영한 최종 상태로 덮어쓴다. */
async function handleEditCommand(interaction: ChatInputCommandInteraction) {
  const findText = interaction.options.getString("찾기", true);
  const changeText = interaction.options.getString("변경", true);
  await interaction.deferReply();
  try {
    const target = await findSingleEventOrReply(interaction, findText);
    if (!target) return; // 못 찾았거나 여러 개면 이미 안내 메시지를 보냈으므로 여기서 종료.

    // "언급 안 된 필드는 기존 값 유지"한 최종 일정 정보를 만들어 그대로 덮어쓴다.
    const updatedInput = await parseEventUpdate(target, changeText);
    const updated = await updateEvent(target.id, updatedInput);
    await interaction.editReply(`✏️ 일정을 수정했습니다\n${formatEventBrief(updated)}`);
  } catch (err) {
    await interaction.editReply(`일정 수정에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/일정삭제` — 일정을 특정한 뒤 삭제/취소 버튼으로 한 번 확인받고서야 실제로 삭제한다 (되돌릴 수 없는 작업이라 등록/수정과 다름). */
async function handleDeleteCommand(interaction: ChatInputCommandInteraction) {
  const findText = interaction.options.getString("찾기", true);
  await interaction.deferReply();
  try {
    const target = await findSingleEventOrReply(interaction, findText);
    if (!target) return;

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
        await button.update({ content: "삭제를 취소했습니다.", components: [] });
      }
    } catch {
      // awaitMessageComponent가 타임아웃되면 예외를 던지는데, 이 경우가 "30초 무응답"에 해당한다.
      await interaction.editReply({ content: "응답 시간이 초과되어 삭제를 취소했습니다.", components: [] });
    }
  } catch (err) {
    await interaction.editReply(`일정 삭제 처리에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/할일추가` — 자연어 문장을 파싱해 기본 할 일 목록에 바로 등록한다. */
async function handleAddTaskCommand(interaction: ChatInputCommandInteraction) {
  const text = interaction.options.getString("내용", true);
  await interaction.deferReply();
  try {
    const parsed = await parseTaskText(text);
    const created = await createTask(parsed);
    await interaction.editReply(`✅ 할 일을 등록했습니다\n${formatTaskBrief(created)}`);
  } catch (err) {
    await interaction.editReply(`할 일 등록에 실패했습니다: ${(err as Error).message}`);
  }
}

/** 자연어로 할 일을 찾는다. 매치가 0개/여러 개면 안내 메시지를 보내고 null을 반환한다. */
async function findSingleTaskOrReply(interaction: ChatInputCommandInteraction, findText: string) {
  const matches = await findMatchingTasks(findText);
  if (matches.length === 0) {
    await interaction.editReply(`"${findText}"에 해당하는 할 일을 찾지 못했습니다.`);
    return null;
  }
  if (matches.length > 1) {
    await interaction.editReply(
      `할 일이 여러 개 찾혔습니다. 더 구체적으로 입력해주세요:\n${formatTaskCandidates(matches)}`,
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
  try {
    const target = await findSingleTaskOrReply(interaction, findText);
    if (!target) return;

    const updatedInput = await parseTaskUpdate(target, changeText);
    const updated = await updateTask(target, updatedInput);
    await interaction.editReply(`✏️ 할 일을 수정했습니다\n${formatTaskBrief(updated)}`);
  } catch (err) {
    await interaction.editReply(`할 일 수정에 실패했습니다: ${(err as Error).message}`);
  }
}

/** `/할일삭제` — 할 일을 특정한 뒤 삭제/취소 버튼으로 한 번 확인받고서야 실제로 삭제한다. */
async function handleDeleteTaskCommand(interaction: ChatInputCommandInteraction) {
  const findText = interaction.options.getString("찾기", true);
  await interaction.deferReply();
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
        await button.update({ content: "삭제를 취소했습니다.", components: [] });
      }
    } catch {
      await interaction.editReply({ content: "응답 시간이 초과되어 삭제를 취소했습니다.", components: [] });
    }
  } catch (err) {
    await interaction.editReply(`할 일 삭제 처리에 실패했습니다: ${(err as Error).message}`);
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
    option.setName("내용").setDescription("예: 다음주 화요일 2시 치과").setRequired(true),
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
    ],
  });
}
