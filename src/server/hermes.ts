import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChannelType, Client, GatewayIntentBits, type GuildTextBasedChannel, type Message } from "discord.js";
import { appendInputMessage, appendPapoMessage } from "../core/conversation";
import { runCuriousHarness } from "../core/harness";
import { makeId } from "../core/ids";
import { createEpisodeFromEvent } from "../core/memory";
import type { ModelProvider } from "../core/provider";
import type { CaptureResult, CognitionContext, ConversationJobRecord, ConversationTurnRecord, CreatureProfile, HermesTaskRecord, MessageCognitionTrace, PlannedAction, SemanticBrainRecord, StreamSegment } from "../core/types";
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
  recoverInterruptedTasks?(): Promise<number>;
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
    },
    async recoverInterruptedTasks() {
      return 0;
    }
  };
}

function createCliHermesBridge(input: { store: ProfileStore; provider: ModelProvider }, env: NodeJS.ProcessEnv): HermesBridge {
  const command = env.PAPO_HERMES_CLI_PATH ?? "hermes";
  const userQueues = new Map<string, Promise<void>>();
  const queuedTaskIds = new Set<string>();

  function enqueueCliRun(userId: string, taskId: string) {
    if (queuedTaskIds.has(taskId)) return;
    queuedTaskIds.add(taskId);
    const previous = userQueues.get(userId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => runCliTask(userId, taskId))
      .finally(() => {
        queuedTaskIds.delete(taskId);
        if (userQueues.get(userId) === next) userQueues.delete(userId);
      });
    userQueues.set(userId, next);
    void next;
  }

  async function runCliTask(userId: string, taskId: string) {
    const profile = await input.store.getProfile(userId);
    const task = profile?.hermes.tasks.find((item) => item.id === taskId);
    if (!profile || !task) return;
    if (task.status !== "pending" && task.status !== "sent") return;
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

  async function recoverInterruptedTasks() {
    const summaries = await input.store.listProfiles();
    let recovered = 0;
    for (const summary of summaries) {
      const profile = await input.store.getProfile(summary.userId);
      if (!profile) continue;
      let changed = false;
      for (const task of profile.hermes.tasks) {
        if (task.status !== "pending" && task.status !== "sent") continue;
        if (queuedTaskIds.has(task.id)) continue;
        const sessionId = task.sessionId ?? profile.hermes.sessionId;
        if (sessionId) {
          task.sessionId = sessionId;
          task.sessionName ??= profile.hermes.sessionName ?? hermesChannelName(profile.userId);
          task.channelName ??= task.sessionName;
          task.updatedAt = new Date().toISOString();
          enqueueCliRun(profile.userId, task.id);
          recovered += 1;
          changed = true;
          continue;
        }
        task.status = "failed";
        task.error = "Papo restarted before Hermes returned a resumable session id.";
        task.updatedAt = new Date().toISOString();
        appendPapoMessage(profile, {
          channel: "curious",
          text: "刚才交给虾虾的任务被服务重启打断了，我没有拿到可靠结果。为了避免重复执行外部任务，请你再说一次，我会重新交给虾虾。",
          sourceId: task.id,
          at: task.updatedAt
        });
        changed = true;
      }
      if (changed) await input.store.saveProfile(profile);
    }
    return recovered;
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
      for (const task of tasks) enqueueCliRun(profile.userId, task.id);
      return tasks;
    },
    start() {
      void recoverInterruptedTasks().catch((error) => console.error("Hermes CLI recovery failed", error));
    },
    stop() {},
    async checkTimeouts(now = new Date().toISOString()) {
      await recoverInterruptedTasks();
      return checkHermesTimeouts(input.store, now);
    },
    recoverInterruptedTasks
  };
}

export function buildHermesCliChatArgs(profile: CreatureProfile, task: HermesTaskRecord) {
  const args = ["chat", "-Q", "--source", "tool", "--accept-hooks", "--yolo", "--max-turns", process.env.PAPO_HERMES_CLI_MAX_TURNS ?? "12"];
  if (profile.hermes.sessionId) args.push("--resume", profile.hermes.sessionId);
  args.push("-q", formatHermesCliTask(profile, task));
  return args;
}

function formatHermesCliTask(profile: CreatureProfile, task: HermesTaskRecord) {
  return [
    "你正在作为 Papo 的后台外部执行器运行，不是在和最终用户实时聊天。",
    `Papo 用户：${profile.userId}`,
    `会话名：${profile.hermes.sessionName ?? hermesChannelName(profile.userId)}`,
    task.title ? `任务标题：${task.title}` : undefined,
    "",
    "执行规则：",
    "- 可以直接完成的事就完成，然后用简洁自然的中文返回执行结果。",
    "- 不能向用户提问、不能调用 clarify、不能等待交互输入。",
    "- 如果缺少凭据、工具、权限或外部系统能力，就不要假装完成，直接返回“无法完成”以及具体原因。",
    "- 不要重复执行已经明确完成过的外部副作用任务；如果无法确认是否完成，说明无法确认。",
    "",
    "任务内容：",
    task.task
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
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
    let sourceEpisode = result.episodes.find((episode) => episode.sourceSegmentId === event.triggerSegmentId || episode.sourceBatchId === event.triggerBatchId);
    if (!sourceEpisode) {
      sourceEpisode = createEpisodeFromEvent(event, result.response, now);
      result.episodes.push(sourceEpisode);
      profile.episodes.unshift(sourceEpisode);
    }
    const task: HermesTaskRecord = {
      id: makeId("hermes_task"),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      task: actionResult.text.trim(),
      title: actionResult.title?.trim(),
      sourceEventId: event.id,
      sourceEpisodeId: sourceEpisode?.id
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
  const task = taskId ? profile.hermes.tasks.find((item) => item.id === taskId) : latestOpenHermesTask(profile);
  if (!task) throw new Error("Hermes result does not match an open task");
  if (task.status === "completed" && task.resultMessageId) return;
  const baseProfile = structuredClone(profile);
  const sourceEpisode = task.sourceEpisodeId
    ? profile.episodes.find((episode) => episode.id === task.sourceEpisodeId)
    : profile.episodes.find((episode) => episode.actionResult?.hermesTaskId === task.id || episode.actionResult?.sourceIds?.includes(task.id))
      ?? createLegacyHermesOrigin(profile, task, now);
  if (!task.sourceEventId || !sourceEpisode) throw new Error("Hermes task is missing its source event or episode");
  task.sourceEpisodeId = sourceEpisode.id;
  const context: CognitionContext = {
    inputSource: "task_result",
    taskId: task.id,
    sourceEventId: task.sourceEventId,
    sourceEpisodeId: sourceEpisode.id
  };
  const segment: StreamSegment = {
    id: makeId("hermes"),
    kind: "text",
    label: "虾虾的回复",
    content,
    observedAt: now,
    batchId: `hermes-${task.id}-${sourceId}`
  };
  const beforeSemanticIds = semanticRecordIds(profile);
  const result = await runCuriousHarness(profile, [segment], provider, now, context);
  const resultTurnId = `turn_hermes_${task.id}`.slice(0, 100);
  const followUpJobs = taskResultJobs(resultTurnId, result, now);
  const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
  const cognitionTrace = captureCognitionTrace(result, provider, "curious_stream", modelRuns);
  const inputMessage = appendInputMessage(profile, {
    channel: "curious",
    role: "world",
    text: `${segment.label}：${segment.content}`,
    sourceId: segment.id,
    turnId: resultTurnId,
    requestId: resultTurnId,
    modality: "text",
    batchId: segment.batchId,
    observedAt: segment.observedAt,
    cognitionTrace
  });
  const papoMessage = appendPapoMessage(profile, {
    channel: "curious",
    text: result.response,
    sourceId: result.episodes[0]?.id ?? result.events[0]?.id ?? segment.id,
    turnId: resultTurnId,
    requestId: resultTurnId,
    relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds),
    cognitionTrace
  });
  const resultEpisode = result.episodes[0];
  task.status = "completed";
  task.resultMessageId = papoMessage?.id;
  task.resultEpisodeId = resultEpisode?.id;
  task.resultText = content.slice(0, 4_000);
  task.updatedAt = now;
  sourceEpisode.creatureResponse = result.response;
  sourceEpisode.actionResult = {
    ...(sourceEpisode.actionResult ?? { kind: "hermes_task" }),
    hermesTaskId: task.id,
    sourceIds: [...new Set([...(sourceEpisode.actionResult?.sourceIds ?? []), task.id, task.sourceEventId, sourceEpisode.id, resultEpisode?.id].filter(Boolean) as string[])]
  };
  const resultTurn: ConversationTurnRecord = {
    id: resultTurnId,
    requestId: resultTurnId,
    channel: "curious",
    status: followUpJobs.length ? "queued" : "completed",
    createdAt: now,
    updatedAt: now,
    completedAt: followUpJobs.length ? undefined : now,
    inputMessageIds: inputMessage ? [inputMessage.id] : [],
    jobIds: followUpJobs.map((job) => job.id),
    segments: [segment]
  };
  const resultEpisodeIds = new Set(result.episodes.map((episode) => episode.id));
  const resultCandidateIds = new Set((result.memoryCandidates ?? []).map((candidate) => candidate.id));
  const baseMemoryIds = new Set(baseProfile.longTermMemories.map((memory) => memory.id));
  const ownedMemories = profile.longTermMemories.filter((memory) => !baseMemoryIds.has(memory.id) || memory.sourceEpisodeId === sourceEpisode.id);
  const baseSemanticIds = new Set(baseProfile.semanticBrainHistory.map((record) => record.id));
  const baseStateChangeKeys = new Set(baseProfile.stateChanges.map((change) => `${change.at}\u0000${change.reason}`));
  const ownedStateChanges = profile.stateChanges.filter((change) => !baseStateChangeKeys.has(`${change.at}\u0000${change.reason}`));
  const stateDelta = cognitionStateDelta(baseProfile, profile);
  const saved = await store.updateProfile(profile.userId, (latest) => {
    latest.state = applyCognitionStateDelta(latest, stateDelta);
    latest.stateChanges = mergeByOwnedKey(latest.stateChanges, ownedStateChanges, (change) => `${change.at}\u0000${change.reason}`).slice(0, 80);
    latest.episodes = mergeByOwnedId(latest.episodes, [sourceEpisode, ...result.episodes.filter((episode) => resultEpisodeIds.has(episode.id))]).slice(0, 80);
    latest.memoryCandidates = mergeByOwnedId(latest.memoryCandidates, profile.memoryCandidates.filter((candidate) => resultCandidateIds.has(candidate.id))).slice(0, 80);
    latest.longTermMemories = mergeByOwnedId(latest.longTermMemories, ownedMemories).slice(0, 80);
    latest.semanticBrainHistory = mergeByOwnedId(latest.semanticBrainHistory, profile.semanticBrainHistory.filter((record) => !baseSemanticIds.has(record.id))).slice(0, 30);
    latest.conversation = mergeByOwnedId(latest.conversation, [inputMessage, papoMessage].filter((message): message is NonNullable<typeof message> => Boolean(message))).slice(0, 80);
    latest.hermes.tasks = mergeByOwnedId(latest.hermes.tasks, [task]).slice(0, 30);
    latest.turns = mergeByOwnedId(latest.turns ?? [], [resultTurn]).slice(0, 80);
    latest.jobs = mergeByOwnedId(latest.jobs ?? [], followUpJobs).slice(0, 240);
    latest.hermes.sessionId = profile.hermes.sessionId ?? latest.hermes.sessionId;
    latest.hermes.sessionName = profile.hermes.sessionName ?? latest.hermes.sessionName;
  });
  if (!saved) throw new Error("Profile disappeared before Hermes result commit");
}

function taskResultJobs(turnId: string, result: CaptureResult, now: string): ConversationJobRecord[] {
  const jobs: ConversationJobRecord[] = [];
  for (const event of result.events) {
    const actions: PlannedAction[] = [
      ...(event.backgroundActions ?? []),
      ...(["generate_illustration", "generate_action_card", "use_hermes"].includes(event.actionDecision.action) && event.actionResult
        ? [{ action: event.actionDecision.action, actionResult: event.actionResult } as PlannedAction]
        : [])
    ];
    for (const [index, action] of actions.entries()) {
      const type = action.action === "generate_illustration" ? "illustration" : action.action === "generate_action_card" ? "action_card" : action.action === "use_hermes" ? "hermes" : undefined;
      if (!type) continue;
      const episode = result.episodes.find((item) => item.sourceSegmentId === event.triggerSegmentId || item.sourceBatchId === event.triggerBatchId);
      jobs.push({
        id: `${turnId}-${type}-${event.id}-${index}`,
        turnId,
        requestId: turnId,
        type,
        stage: "action",
        status: "queued",
        attempt: 0,
        maxAttempts: 3,
        retryable: true,
        createdAt: now,
        updatedAt: now,
        sourceIds: [...new Set([turnId, event.sourceTaskId, event.id, event.triggerSegmentId, episode?.id, ...(action.actionResult.sourceIds ?? [])].filter(Boolean) as string[])],
        eventId: event.id,
        event: structuredClone(event),
        episodeId: episode?.id,
        action: structuredClone(action)
      });
    }
  }
  return jobs;
}

function mergeByOwnedId<T extends { id: string }>(current: T[], owned: T[]) {
  const ids = new Set(owned.map((item) => item.id));
  return [...owned, ...current.filter((item) => !ids.has(item.id))];
}

function mergeByOwnedKey<T>(current: T[], owned: T[], keyOf: (item: T) => string) {
  const ids = new Set(owned.map(keyOf));
  return [...owned, ...current.filter((item) => !ids.has(keyOf(item)))];
}

function cognitionStateDelta(before: CreatureProfile, after: CreatureProfile) {
  const keys = ["curiosity", "attachment", "energy", "arousal", "safety", "confidence"] as const;
  return Object.fromEntries(keys.map((key) => [key, after.state[key] - before.state[key]])) as Record<typeof keys[number], number>;
}

function applyCognitionStateDelta(profile: CreatureProfile, delta: ReturnType<typeof cognitionStateDelta>) {
  const state = structuredClone(profile.state);
  for (const key of Object.keys(delta) as Array<keyof typeof delta>) state[key] = Math.max(0, Math.min(100, Math.round(state[key] + delta[key])));
  state.mood = state.energy < 30 ? "tired" : state.safety > 74 ? "careful" : state.attachment > 70 ? "attached" : state.confidence > 70 && state.energy > 55 ? "bright" : state.arousal < 36 ? "calm" : "curious";
  return state;
}

function createLegacyHermesOrigin(profile: CreatureProfile, task: HermesTaskRecord, now: string) {
  task.sourceEventId ??= `hermes_origin_${task.id}`;
  const episodeId = `episode_${task.id}`;
  const existing = profile.episodes.find((episode) => episode.id === episodeId);
  if (existing) return existing;
  const episode = {
    id: episodeId,
    createdAt: task.createdAt || now,
    source: "button" as const,
    cognitionSource: "direct" as const,
    sourceTaskId: task.id,
    inputSummary: task.task,
    noticed: "这是升级前交给 Hermes 的原始任务请求。",
    possibleIntent: "等待外部任务结果",
    importanceReason: "由旧 Hermes task 恢复原请求来源。",
    relatedMemoryIds: [],
    stateSnapshot: structuredClone(profile.state),
    creatureResponse: "",
    feedback: [],
    promotedToLongTerm: false,
    memoryCandidateIds: [],
    actionDecision: {
      action: "use_hermes" as const,
      confidence: 100,
      reason: "legacy Hermes task origin recovery",
      blockedActions: [],
      safetyNotes: [],
      llmSuggestedAction: "use_hermes" as const,
      ruleTrace: ["migration=legacy_hermes_task_origin"]
    },
    actionResult: { kind: "hermes_task" as const, title: task.title, text: task.task, hermesTaskId: task.id, sourceIds: [task.id] },
    creatureExperience: { earReason: "", actionFeeling: "", saveFeeling: "" },
    weight: 40,
    tags: ["Hermes", "迁移"],
    decisionTrace: ["migration: restored source episode from durable Hermes task"]
  };
  profile.episodes.unshift(episode);
  return episode;
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
    attentionDecision: result.curiousSession ? {
      attentionBudget: result.curiousSession.attentionBudget,
      selected: result.curiousSession.selected,
      ignored: result.curiousSession.ignored,
      creatureReport: result.curiousSession.creatureReport
    } : undefined,
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
