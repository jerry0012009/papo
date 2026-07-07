import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChannelType, Client, GatewayIntentBits, type GuildTextBasedChannel, type Message } from "discord.js";
import { appendInputMessage, appendPapoMessage } from "../core/conversation";
import { runCuriousHarness } from "../core/harness";
import { makeId } from "../core/ids";
import type { ModelProvider } from "../core/provider";
import type { CaptureResult, CreatureProfile, HermesTaskRecord, MessageCognitionTrace, SemanticBrainRecord, StreamSegment } from "../core/types";
import { loadServerEnv } from "./env";
import type { ProfileStore } from "./store";

const HERMES_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const execFileAsync = promisify(execFile);

export interface HermesBridge {
  enabled: boolean;
  enqueueTasks(profile: CreatureProfile, result: CaptureResult): Promise<HermesTaskRecord[]>;
  start(): void;
  stop(): void;
  checkTimeouts(now?: string): Promise<number>;
}

export function createHermesBridge(input: { store: ProfileStore; provider: ModelProvider; env?: NodeJS.ProcessEnv }): HermesBridge {
  const env = loadServerEnv(input.env);
  const dispatchMode = (env.PAPO_HERMES_DISPATCH ?? "auto").toLowerCase();
  if (dispatchMode === "cli") return createCliHermesBridge(input, env);
  const token = env.PAPO_DISCORD_BOT_TOKEN ?? env.DISCORD_BOT_TOKEN;
  const guildId = env.PAPO_DISCORD_GUILD_ID ?? env.DISCORD_GUILD_ID;
  const categoryId = env.PAPO_DISCORD_CATEGORY_ID;
  const parentChannelId = env.PAPO_DISCORD_PARENT_CHANNEL_ID ?? env.DISCORD_HOME_CHANNEL;
  const hermesBotId = env.PAPO_HERMES_BOT_ID ?? env.HERMES_BOT_ID;
  if (!token || !guildId) return disabledBridge();
  const configuredGuildId = guildId;

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
  let started = false;
  let ready: Promise<Client<true>> | undefined;

  async function readyClient() {
    if (client.isReady()) return client;
    ready ??= new Promise<Client<true>>((resolve, reject) => {
      client.once("ready", () => resolve(client as Client<true>));
      client.once("error", reject);
      void client.login(token);
    });
    return ready;
  }

  async function getOrCreateChannel(profile: CreatureProfile) {
    const existingId = profile.hermes.channelId;
    const activeClient = await readyClient();
    if (existingId) {
      const existing = await activeClient.channels.fetch(existingId).catch(() => undefined);
      if (existing?.isTextBased()) return existing as GuildTextBasedChannel;
    }
    const guild = await activeClient.guilds.fetch(configuredGuildId);
    const channelName = hermesChannelName(profile.userId);
    const channels = await guild.channels.fetch();
    const existing = channels.find((channel) => channel?.type === ChannelType.GuildText && channel.name === channelName);
    if (existing && existing.type === ChannelType.GuildText) {
      profile.hermes.channelId = existing.id;
      profile.hermes.channelName = existing.name;
      return existing;
    }
    try {
      const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryId
          });
      profile.hermes.channelId = channel.id;
      profile.hermes.channelName = channel.name;
      return channel;
    } catch (error) {
      if (!parentChannelId || !isDiscordMissingPermission(error)) throw error;
      const parent = await activeClient.channels.fetch(parentChannelId);
      if (!parent || !("threads" in parent) || !parent.isTextBased()) throw error;
      const thread = await parent.threads.create({
        name: channelName,
        autoArchiveDuration: 1440,
        reason: "Papo Hermes user session"
      });
      profile.hermes.channelId = thread.id;
      profile.hermes.channelName = thread.name;
      return thread;
    }
  }

  async function dispatchTask(profile: CreatureProfile, task: HermesTaskRecord) {
    try {
      const channel = await getOrCreateChannel(profile);
      const message = await channel.send(formatHermesTaskMessage(profile, task));
      task.status = "sent";
      task.channelId = channel.id;
      task.channelName = "name" in channel ? channel.name : profile.hermes.channelName;
      task.sentMessageId = message.id;
      task.updatedAt = new Date().toISOString();
      await input.store.saveProfile(profile);
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      await input.store.saveProfile(profile);
      console.error(`Hermes task dispatch failed for ${profile.userId}`, error);
    }
  }

  async function handleHermesMessage(message: Message) {
    if (!message.content.trim()) return;
    if (message.author.id === client.user?.id) return;
    if (hermesBotId && message.author.id !== hermesBotId) return;
    const profile = await profileForHermesChannel(input.store, message.channelId);
    if (!profile) return;
    const sentMessageIds = new Set(profile.hermes.tasks.map((task) => task.sentMessageId).filter(Boolean));
    if (sentMessageIds.has(message.id)) return;
    await processHermesReply(profile, message.content.trim(), message.id);
  }

  async function processHermesReply(profile: CreatureProfile, content: string, discordMessageId: string) {
    const task = latestOpenHermesTask(profile);
    await processHermesReplyWithProvider(input.store, input.provider, profile, content, task?.id, discordMessageId);
  }

  return {
    enabled: true,
    async enqueueTasks(profile, result) {
      const tasks = hermesTasksFromResult(profile, result);
      if (!tasks.length) return [];
      profile.hermes.tasks.unshift(...tasks);
      profile.hermes.tasks = profile.hermes.tasks.slice(0, 30);
      await input.store.saveProfile(profile);
      for (const task of tasks) void dispatchTask(profile, task);
      return tasks;
    },
    start() {
      if (started) return;
      started = true;
      client.on("messageCreate", (message) => {
        void handleHermesMessage(message).catch((error) => console.error("Hermes reply handling failed", error));
      });
      void readyClient().catch((error) => console.error("Hermes Discord bridge failed to start", error));
    },
    stop() {
      client.removeAllListeners("messageCreate");
      client.destroy();
      started = false;
      ready = undefined;
    },
    async checkTimeouts(now = new Date().toISOString()) {
      return checkHermesTimeouts(input.store, now);
    }
  };
}

function createCliHermesBridge(input: { store: ProfileStore; provider: ModelProvider }, env: NodeJS.ProcessEnv): HermesBridge {
  const command = env.PAPO_HERMES_CLI_PATH ?? "hermes";
  async function runCliTask(userId: string, taskId: string) {
    const profile = await input.store.getProfile(userId);
    const task = profile?.hermes.tasks.find((item) => item.id === taskId);
    if (!profile || !task) return;
    try {
      const sessionName = profile.hermes.sessionName ?? hermesChannelName(profile.userId);
      const args = buildHermesCliChatArgs(profile, task);
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: Number(env.PAPO_HERMES_CLI_TIMEOUT_MS ?? 30 * 60_000),
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, ...env }
      });
      const parsed = parseHermesCliChatOutput(stdout, stderr);
      const current = await input.store.getProfile(userId);
      if (!current) return;
      const resolvedSessionId = parsed.sessionId ?? current.hermes.sessionId ?? profile.hermes.sessionId;
      if (resolvedSessionId && !current.hermes.sessionId) {
        current.hermes.sessionId = resolvedSessionId;
        current.hermes.sessionName = sessionName;
        if (parsed.sessionId) await renameHermesSession(command, parsed.sessionId, sessionName, env);
      }
      const currentTask = current.hermes.tasks.find((item) => item.id === taskId);
      if (currentTask) {
        currentTask.sessionId = resolvedSessionId;
        currentTask.sessionName = sessionName;
        currentTask.channelName = sessionName;
        currentTask.updatedAt = new Date().toISOString();
      }
      await processHermesReplyWithProvider(input.store, input.provider, current, parsed.content || "虾虾没有返回可用内容。", taskId);
    } catch (error) {
      const current = await input.store.getProfile(userId);
      const currentTask = current?.hermes.tasks.find((item) => item.id === taskId);
      if (!current || !currentTask) return;
      currentTask.status = "failed";
      currentTask.error = error instanceof Error ? error.message : String(error);
      currentTask.updatedAt = new Date().toISOString();
      appendPapoMessage(current, {
        channel: "curious",
        text: "虾虾这次没处理完，我没有拿到可靠结果。",
        sourceId: currentTask.id
      });
      await input.store.saveProfile(current);
    }
  }

  return {
    enabled: true,
    async enqueueTasks(profile, result) {
      const tasks = hermesTasksFromResult(profile, result);
      if (!tasks.length) return [];
      for (const task of tasks) {
        task.status = "sent";
        task.channelName = profile.hermes.sessionName ?? hermesChannelName(profile.userId);
        task.sessionId = profile.hermes.sessionId;
        task.sessionName = profile.hermes.sessionName ?? hermesChannelName(profile.userId);
        task.updatedAt = new Date().toISOString();
      }
      profile.hermes.tasks.unshift(...tasks);
      profile.hermes.tasks = profile.hermes.tasks.slice(0, 30);
      await input.store.saveProfile(profile);
      for (const task of tasks) void runCliTask(profile.userId, task.id);
      return tasks;
    },
    start() {},
    stop() {},
    async checkTimeouts(now = new Date().toISOString()) {
      return checkHermesTimeouts(input.store, now);
    }
  };
}

export function buildHermesCliChatArgs(profile: CreatureProfile, task: HermesTaskRecord) {
  const args = ["chat", "-Q", "--source", "tool"];
  if (profile.hermes.sessionId) args.push("--resume", profile.hermes.sessionId);
  args.push("-q", task.task);
  return args;
}

export function parseHermesCliChatOutput(stdout: string, stderr = "") {
  const sessionId = extractHermesSessionId(`${stderr}\n${stdout}`);
  const contentLines: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.match(/^\s*session_id:\s*(\S+)\s*$/)) continue;
    contentLines.push(line);
  }
  return {
    sessionId,
    content: contentLines.join("\n").trim()
  };
}

function extractHermesSessionId(output: string) {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*session_id:\s*(\S+)\s*$/);
    if (match) return match[1];
  }
  return undefined;
}

async function renameHermesSession(command: string, sessionId: string, sessionName: string, env: NodeJS.ProcessEnv) {
  try {
    await execFileAsync(command, ["sessions", "rename", sessionId, sessionName], {
      timeout: 20_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, ...env }
    });
  } catch (error) {
    console.warn(`Hermes session rename failed for ${sessionId}`, error);
  }
}

function disabledBridge(): HermesBridge {
  return {
    enabled: false,
    async enqueueTasks() {
      return [];
    },
    start() {},
    stop() {},
    async checkTimeouts() {
      return 0;
    }
  };
}

function hermesTasksFromResult(profile: CreatureProfile, result: CaptureResult): HermesTaskRecord[] {
  const tasks: HermesTaskRecord[] = [];
  const now = new Date().toISOString();
  for (const event of result.events) {
    const actionResult = event.actionResult;
    if (event.actionDecision.action !== "use_hermes" || actionResult?.kind !== "hermes_task" || !actionResult.text?.trim()) continue;
    const task: HermesTaskRecord = {
      id: makeId("hermes_task"),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      task: actionResult.text.trim(),
      title: actionResult.title?.trim(),
      sourceEventId: event.id
    };
    actionResult.hermesTaskId = task.id;
    tasks.push(task);
  }
  void profile;
  return tasks;
}

function formatHermesTaskMessage(profile: CreatureProfile, task: HermesTaskRecord) {
  return [
    `Papo 用户 ${profile.userId} 想请虾虾帮忙。`,
    task.title ? `任务：${task.title}` : undefined,
    "",
    task.task,
    "",
    "请完成后直接回复结果；Papo 会把你的回复转述给用户。"
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function hermesChannelName(userId: string) {
  const suffix = userId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `papo-${suffix || "user"}`;
}

function isDiscordMissingPermission(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 50013;
}

async function profileForHermesChannel(store: ProfileStore, channelId: string) {
  const summaries = await store.listProfiles();
  for (const summary of summaries) {
    const profile = await store.getProfile(summary.userId);
    if (profile?.hermes.channelId === channelId) return profile;
  }
  return undefined;
}

function latestOpenHermesTask(profile: CreatureProfile) {
  return profile.hermes.tasks.find((task) => task.status === "sent" || task.status === "pending");
}

async function processHermesReplyWithProvider(
  store: ProfileStore,
  provider: ModelProvider,
  profile: CreatureProfile,
  content: string,
  taskId?: string,
  sourceId = makeId("hermes_source")
) {
  const now = new Date().toISOString();
  const segment: StreamSegment = {
    id: makeId("hermes"),
    kind: "text",
    label: "虾虾的回复",
    content,
    observedAt: now,
    batchId: `hermes-${sourceId}`
  };
  const beforeSemanticIds = semanticRecordIds(profile);
  const result = await runCuriousHarness(profile, [segment], provider, now);
  const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
  const cognitionTrace = captureCognitionTrace(result, provider, "curious_stream", modelRuns);
  appendInputMessage(profile, {
    channel: "curious",
    role: "world",
    text: `${segment.label}：${segment.content}`,
    sourceId: segment.id,
    modality: "text",
    batchId: segment.batchId,
    observedAt: segment.observedAt,
    cognitionTrace
  });
  const papoMessage = appendPapoMessage(profile, {
    channel: "curious",
    text: result.response,
    sourceId: result.episodes[0]?.id ?? result.events[0]?.id ?? segment.id,
    relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds),
    cognitionTrace
  });
  const task = taskId ? profile.hermes.tasks.find((item) => item.id === taskId) : latestOpenHermesTask(profile);
  if (task) {
    task.status = "completed";
    task.resultMessageId = papoMessage?.id;
    task.updatedAt = now;
  }
  await store.saveProfile(profile);
}

async function checkHermesTimeouts(store: ProfileStore, now: string) {
  const summaries = await store.listProfiles();
  let timedOut = 0;
  for (const summary of summaries) {
    const profile = await store.getProfile(summary.userId);
    if (!profile) continue;
    let changed = false;
    for (const task of profile.hermes.tasks) {
      if (task.status !== "pending" && task.status !== "sent") continue;
      if (Date.parse(now) - Date.parse(task.createdAt) < HERMES_TASK_TIMEOUT_MS) continue;
      task.status = "timeout";
      task.updatedAt = now;
      appendPapoMessage(profile, {
        channel: "curious",
        text: "虾虾可能在忙，等它回来的时候我再告诉你。",
        sourceId: task.id,
        at: now
      });
      changed = true;
      timedOut += 1;
    }
    if (changed) await store.saveProfile(profile);
  }
  return timedOut;
}

function semanticRecordIds(profile: CreatureProfile) {
  return new Set(profile.semanticBrainHistory.map((record) => record.id));
}

function newSemanticRuns(profile: CreatureProfile, before: Set<string>) {
  return profile.semanticBrainHistory.filter((record) => !before.has(record.id));
}

function captureCognitionTrace(
  result: CaptureResult,
  provider: ModelProvider,
  source: SemanticBrainRecord["source"],
  modelRuns: SemanticBrainRecord[]
): MessageCognitionTrace {
  return {
    at: new Date().toISOString(),
    source,
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    modelRuns,
    harnessTrace: result.harnessTrace,
    eventDecisions: result.events.map((event) => {
      const episode = result.episodes.find((item) => item.sourceSegmentId === event.triggerSegmentId);
      const memoryCandidateKept = Boolean(result.memoryCandidates?.some((candidate) => candidate.sourceEpisodeId === episode?.id));
      return {
        eventId: event.id,
        sourceLabel: event.triggerLabel,
        sourceText: event.triggerContent,
        action: event.actionDecision.action,
        semanticSource: event.semanticSource,
        noticed: event.noticed,
        reason: event.reason,
        visibleReply: event.id === result.events[0]?.id ? result.response : undefined,
        actionResult: event.actionResult,
        stateDeltas: event.actionStateDeltas,
        episodeKept: Boolean(episode),
        memoryCandidateKept,
        relatedMemoryIds: event.relatedMemoryIds,
        decisionTrace: event.decisionTrace ?? event.actionDecision.ruleTrace ?? []
      };
    }),
    episodeDecisions: result.episodes.map((episode) => ({
      episodeId: episode.id,
      action: episode.actionDecision?.action,
      kept: true,
      memoryCandidateIds: episode.memoryCandidateIds,
      decisionTrace: episode.decisionTrace ?? episode.actionDecision?.ruleTrace ?? []
    })),
    memoryDecisions: (result.memoryCandidates ?? []).map((candidate) => ({
      candidateId: candidate.id,
      sourceEpisodeId: candidate.sourceEpisodeId,
      status: candidate.status,
      writePolicy: candidate.writePolicy,
      memoryKind: candidate.memoryKind,
      text: candidate.candidateText,
      why: candidate.whyConsolidate
    }))
  };
}
