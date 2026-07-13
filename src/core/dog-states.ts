import { z } from "zod";
import { makeId } from "./ids";
import { modelConversationContext, modelMemoryContext, modelPetContext } from "./model-context";
import type { ModelProvider } from "./provider";
import { addMinutes, modelTimeContext } from "./time";
import { markMeaningfulUserActivity } from "./proactive";
import type { CreatureProfile, DogInteractionState } from "./types";

export interface DogStateCatalogItem {
  id: string;
  label: string;
  actionText: string;
  visualPrompt: string;
  animation: DogInteractionState["animation"];
  tags: string[];
}

export const DOG_STATE_CHECK_INTERVAL_MINUTES = 60;
export type PetTouchAction = "idle" | "poke-wave" | "play-ball" | "nap";

export const DOG_STATE_CATALOG: DogStateCatalogItem[] = [
  state("curious_peek", "悄悄看你", "Papo 从旁边探出小脑袋，悄悄看了你一眼。", "Shiba peeking from the side with one paw forward", "peek", ["curious", "quiet"]),
  state("soft_wag_near", "靠近一点", "Papo 靠近了一点，尾巴轻轻晃着。", "Shiba sitting close with a soft wagging tail", "wag", ["attached", "calm"]),
  state("sun_patch", "晒太阳", "Papo 趴在一小块阳光里，眯着眼晒太阳。", "Shiba lying in a warm sun patch", "sun", ["calm", "rest"]),
  state("ball_ready", "抱着球等你", "Papo 把小球抱在爪子边，等你看过来。", "Shiba holding a small ball between front paws", "play", ["play", "active"]),
  state("slow_blink", "慢慢眨眼", "Papo 慢慢眨了眨眼，安静待在你旁边。", "Shiba blinking slowly while sitting still", "idle", ["calm", "quiet"]),
  state("ear_tilt", "歪头听你", "Papo 歪了歪头，好像在认真听。", "Shiba tilting its head with raised ears", "listen", ["listen", "curious"]),
  state("tiny_stretch", "伸个懒腰", "Papo 前爪往前伸，舒舒服服地伸了个懒腰。", "Shiba doing a front-leg stretch", "stretch", ["rest", "wake"]),
  state("sleepy_curl", "团成一小团", "Papo 团成一小团，尾巴搭在鼻尖旁边。", "Shiba curled up into a small sleeping ball", "nap", ["sleepy", "quiet"]),
  state("door_wait", "在门边等", "Papo 坐在门边，像是在等你回来。", "Shiba sitting by a door looking hopeful", "idle", ["attached", "waiting"]),
  state("sniff_floor", "闻闻地板", "Papo 低头闻了闻地板，像发现了一点新味道。", "Shiba sniffing the floor carefully", "sniff", ["curious", "explore"]),
  state("paw_tap", "轻轻拍爪", "Papo 用前爪轻轻拍了一下地面。", "Shiba tapping one paw gently", "bounce", ["active", "attention"]),
  state("blanket_nest", "钻进小毯子", "Papo 钻进小毯子，只露出圆圆的脸。", "Shiba tucked under a small blanket", "nap", ["cozy", "rest"]),
  state("window_watch", "看窗外", "Papo 趴在窗边，看着外面的光。", "Shiba watching outside from a window", "idle", ["calm", "observe"]),
  state("happy_bounce", "小跳一下", "Papo 小小跳了一下，尾巴摇得快起来。", "Shiba doing a tiny happy bounce", "bounce", ["happy", "active"]),
  state("toy_nudge", "把玩具推过来", "Papo 把玩具用鼻尖轻轻推到你这边。", "Shiba nudging a toy forward with its nose", "play", ["play", "invite"]),
  state("quiet_guard", "安静守着", "Papo 安静坐着，像在替你守一会儿。", "Shiba sitting calmly like a tiny guardian", "idle", ["safe", "quiet"]),
  state("food_bowl_glance", "看一眼碗", "Papo 看了一眼小碗，又看了看你。", "Shiba glancing between a food bowl and the user", "peek", ["need", "cute"]),
  state("rain_listen", "听雨声", "Papo 贴着窗边，安静听外面的雨声。", "Shiba near a window listening to rain", "listen", ["calm", "weather"]),
  state("desk_companion", "趴在桌边", "Papo 趴在桌边，陪你待在这里。", "Shiba resting beside a desk", "idle", ["work", "companion"]),
  state("soft_roll", "翻一下肚皮", "Papo 轻轻翻了个身，露出软软的小肚皮。", "Shiba rolling onto its back playfully", "play", ["trust", "cute"]),
  state("nose_boops_air", "鼻尖点点空气", "Papo 鼻尖在空气里点了两下，好像闻到了什么。", "Shiba booping the air with its nose", "sniff", ["curious", "cute"]),
  state("side_sit", "斜斜坐着", "Papo 斜斜坐着，尾巴绕在爪边。", "Shiba sitting sideways with tail around paws", "idle", ["calm"]),
  state("tiny_yawn", "打个小哈欠", "Papo 打了个小哈欠，又努力睁开眼。", "Shiba making a tiny yawn", "nap", ["sleepy"]),
  state("leaf_chase", "追一片叶子", "Papo 追着想象里的小叶子跑了两步。", "Shiba chasing a small falling leaf", "play", ["play", "outdoor"]),
  state("tail_circle", "尾巴绕圈", "Papo 的尾巴绕了个小圈，像在藏不住开心。", "Shiba wagging curled tail in a circle", "wag", ["happy"]),
  state("head_on_paws", "下巴搭爪", "Papo 把下巴搭在前爪上，安安静静看着你。", "Shiba resting chin on front paws", "idle", ["calm", "attached"]),
  state("little_prance", "轻快踱步", "Papo 轻快地来回踱了几步。", "Shiba prancing lightly back and forth", "bounce", ["active"]),
  state("snack_dream", "像梦到小零食", "Papo 睡得很香，爪子轻轻动了一下。", "Shiba napping and twitching paws in a snack dream", "nap", ["dream", "cute"]),
  state("garden_sniff", "闻小花", "Papo 低头闻了闻一朵小花。", "Shiba sniffing a tiny flower", "sniff", ["outdoor", "curious"]),
  state("moon_watch", "看月亮", "Papo 坐在柔柔的夜色里，看着月亮。", "Shiba sitting under moonlight", "idle", ["night", "calm"]),
  state("morning_spin", "早安转圈", "Papo 原地转了半圈，像在说早安。", "Shiba making a morning half spin", "bounce", ["morning", "happy"]),
  state("pillow_squish", "挤在枕头边", "Papo 挤在枕头边，脸颊被压得圆圆的。", "Shiba squished against a pillow", "nap", ["cozy"]),
  state("sock_find", "找到一只袜子", "Papo 叼来一只袜子，又有点不好意思。", "Shiba carrying a sock bashfully", "play", ["mischief"]),
  state("soft_pounce", "轻轻扑一下", "Papo 往前轻轻扑了一下，又马上坐好。", "Shiba doing a gentle playful pounce", "play", ["play", "cute"]),
  state("tea_steam_watch", "看热气", "Papo 看着杯子上方的热气慢慢飘。", "Shiba watching steam curl upward", "peek", ["calm", "observe"]),
  state("book_corner", "靠着书角", "Papo 靠在书边，像要陪你读一会儿。", "Shiba leaning against a book", "idle", ["study", "companion"]),
  state("tiny_hop_back", "后退小跳", "Papo 往后小跳一步，像被自己的影子逗到了。", "Shiba hopping backward playfully", "bounce", ["play"]),
  state("shadow_chase", "追自己的影子", "Papo 盯着自己的影子，认真追了一小段。", "Shiba chasing its own shadow", "play", ["curious", "fun"]),
  state("soft_sigh", "轻轻叹气", "Papo 轻轻呼了一口气，放松下来。", "Shiba making a soft relaxed sigh", "idle", ["calm"]),
  state("closer_cuddle", "贴近一点", "Papo 又贴近了一点，像想把位置让暖。", "Shiba moving closer for a cuddle", "wag", ["attached", "warm"]),
  state("paper_crinkle", "听纸声", "Papo 被一点纸声吸引，耳朵动了动。", "Shiba ears reacting to paper crinkle", "listen", ["curious", "sound"]),
  state("floor_sploot", "趴成小面包", "Papo 趴成小面包，后腿软软地摊开。", "Shiba doing a sploot pose", "nap", ["rest", "cute"]),
  state("star_gaze", "看星星", "Papo 抬头看着星星，眼睛亮亮的。", "Shiba gazing up at stars", "peek", ["night", "wonder"]),
  state("tiny_dig", "假装刨地", "Papo 用爪子刨了两下，像在整理自己的小窝。", "Shiba lightly digging at a blanket nest", "play", ["nest", "active"]),
  state("listen_left", "左耳听听", "Papo 左耳先动了一下，像捕捉到一点声音。", "Shiba twitching left ear to listen", "listen", ["listen"]),
  state("listen_right", "右耳听听", "Papo 右耳动了动，安静分辨周围的声音。", "Shiba twitching right ear to listen", "listen", ["listen"]),
  state("little_bow", "小小鞠躬", "Papo 前爪压低，做了一个小小的玩耍邀请。", "Shiba play bow with front paws low", "stretch", ["play", "invite"]),
  state("soft_shake", "抖抖毛", "Papo 抖了抖身上的毛，重新精神起来。", "Shiba shaking its fur softly", "bounce", ["reset", "active"]),
  state("paw_over_nose", "爪子盖鼻尖", "Papo 用小爪子盖住鼻尖，像在偷懒。", "Shiba covering nose with paw", "nap", ["cute", "sleepy"]),
  state("beside_phone", "守在手机旁", "Papo 守在手机旁边，等你回来看看它。", "Shiba waiting beside a phone", "idle", ["waiting", "attached"]),
  state("tiny_celebrate", "小小庆祝", "Papo 原地蹦了一下，像替你开心。", "Shiba doing a tiny celebration jump", "bounce", ["happy", "support"]),
  state("soft_concern", "担心地靠近", "Papo 靠近一点，眼神软软的。", "Shiba approaching gently with concerned eyes", "peek", ["care", "safe"]),
  state("blanket_drag", "拖来小毯子", "Papo 拖来一角小毯子，像想把这里铺暖。", "Shiba dragging a small blanket corner", "play", ["cozy", "care"]),
  state("water_bowl_watch", "看水碗", "Papo 看了看水碗，舔了舔鼻尖。", "Shiba looking at a water bowl", "sniff", ["need", "calm"]),
  state("small_patrol", "小范围巡逻", "Papo 绕着附近走了一圈，又回到你身边。", "Shiba making a tiny patrol and returning", "walk", ["safe", "active"].filter(Boolean) as string[]),
  state("couch_corner", "窝在沙发角", "Papo 窝在沙发角落，舒服得不想动。", "Shiba nestled in couch corner", "nap", ["cozy", "rest"]),
  state("gentle_nod", "轻轻点头", "Papo 轻轻点了下头，像听懂了一点。", "Shiba giving a tiny nod", "listen", ["listen", "attached"]),
  state("toy_guard", "守着玩具", "Papo 把玩具放在身边，认真守着。", "Shiba guarding a favorite toy softly", "idle", ["play", "attached"]),
  state("half_asleep_watch", "半睡半醒", "Papo 半睡半醒地看着你，眼睛快合上了。", "Shiba half-asleep but watching", "nap", ["sleepy", "attached"]),
  state("fresh_air_sniff", "闻新鲜空气", "Papo 抬起鼻尖，像闻到一点新鲜空气。", "Shiba lifting nose to sniff fresh air", "sniff", ["outdoor", "curious"]),
  state("keyboard_nearby", "蹲在键盘旁", "Papo 蹲在键盘旁边，乖乖不碰按键。", "Shiba sitting beside a keyboard politely", "idle", ["work", "companion"]),
  state("little_scamper", "小跑两步", "Papo 小跑了两步，又回头看你。", "Shiba scampering two steps and looking back", "bounce", ["active", "invite"]),
  state("soft_hide", "藏在角落", "Papo 藏在角落里，只露出一只耳朵。", "Shiba hiding in corner with one ear visible", "peek", ["shy", "quiet"]),
  state("warm_floor", "贴着暖地板", "Papo 贴着暖暖的地板，舒服地趴着。", "Shiba lying on warm floor", "sun", ["warm", "rest"]),
  state("tiny_whine", "小声哼哼", "Papo 小声哼哼了一下，像想被注意到。", "Shiba making a tiny attention whine", "listen", ["attention", "attached"]),
  state("proud_sit", "坐得很端正", "Papo 坐得端端正正，好像很骄傲。", "Shiba sitting proudly upright", "idle", ["confident"]),
  state("paw_wave", "挥挥小爪", "Papo 抬起小爪，轻轻挥了一下。", "Shiba waving one paw", "bounce", ["greet", "cute"]),
  state("sniff_screen", "闻闻屏幕", "Papo 凑近屏幕闻了闻，好像在确认你在。", "Shiba sniffing toward the screen", "sniff", ["curious", "attached"]),
  state("quiet_tail_tip", "尾巴尖动动", "Papo 只有尾巴尖轻轻动了动。", "Shiba lying still with only tail tip moving", "idle", ["quiet", "calm"]),
  state("treat_wait", "等小奖励", "Papo 坐好等着，像在等一颗小奖励。", "Shiba sitting politely for a treat", "idle", ["hope", "cute"]),
  state("soft_jump_place", "原地小跳", "Papo 原地小跳了一下，又稳稳落地。", "Shiba tiny jump in place", "bounce", ["happy", "active"]),
  state("nap_by_lamp", "灯旁小睡", "Papo 在小灯旁边睡着了，影子软软的。", "Shiba napping beside a warm lamp", "nap", ["night", "cozy"]),
  state("morning_sniff", "早晨闻闻", "Papo 闻了闻早晨的空气，精神了一点。", "Shiba sniffing morning air", "sniff", ["morning", "fresh"]),
  state("evening_calm", "傍晚安静", "Papo 在傍晚的光里安静坐着。", "Shiba sitting in evening light", "sun", ["evening", "calm"]),
  state("tiny_confused", "有点迷糊", "Papo 眨眨眼，像刚刚没完全反应过来。", "Shiba blinking with a slightly confused cute face", "peek", ["confused", "cute"]),
  state("follow_steps", "跟着走两步", "Papo 跟着你的方向走了两步。", "Shiba following two small steps", "bounce", ["attached", "follow"]),
  state("soft_guard_sleep", "守着睡", "Papo 趴在一旁睡着了，但耳朵还轻轻动着。", "Shiba sleeping nearby with ears slightly alert", "nap", ["safe", "attached"]),
  state("little_shiver", "轻轻抖一下", "Papo 轻轻抖了一下，又往暖的地方靠。", "Shiba giving a tiny shiver then moving warm", "stretch", ["need", "cozy"]),
  state("tiny_sneeze", "打个小喷嚏", "Papo 打了个小喷嚏，自己也愣了一下。", "Shiba tiny sneeze with surprised face", "bounce", ["cute", "reset"]),
  state("soft_focus", "认真盯着", "Papo 认真盯着你，好像在等下一句话。", "Shiba focused gaze toward user", "listen", ["focus", "listen"]),
  state("corner_sunbeam", "追阳光边边", "Papo 把爪子挪到阳光边边上。", "Shiba moving paw into the edge of sunlight", "sun", ["sun", "cute"]),
  state("tiny_spin", "转一小圈", "Papo 转了一小圈，像给自己找个舒服角度。", "Shiba making a tiny spin before sitting", "bounce", ["active", "settle"]),
  state("soft_nose_touch", "鼻尖碰碰", "Papo 用鼻尖轻轻碰了一下空气。", "Shiba gently touching air with nose", "sniff", ["cute", "attached"]),
  state("toy_under_paw", "玩具压爪下", "Papo 把玩具压在爪子下面，假装很认真。", "Shiba holding toy under one paw", "play", ["play", "proud"]),
  state("quiet_after_play", "玩累了趴下", "Papo 玩累了，趴下来慢慢喘气。", "Shiba resting after play", "nap", ["tired", "play"]),
  state("hear_name", "听见名字", "Papo 像听见自己的名字，耳朵一下竖起来。", "Shiba ears perking up at its name", "listen", ["name", "alert"]),
  state("soft_wait_reply", "等你回话", "Papo 乖乖等你回话，没有催你。", "Shiba patiently waiting for reply", "idle", ["waiting", "gentle"]),
  state("small_comfort", "挨着陪你", "Papo 挨着你坐下，像在陪你缓一缓。", "Shiba sitting close for comfort", "wag", ["comfort", "attached"]),
  state("curtain_peek", "从帘子后看", "Papo 从帘子后面探出脸。", "Shiba peeking from behind a curtain", "peek", ["curious", "shy"]),
  state("mini_zoom", "小小冲刺", "Papo 突然小小冲刺了一下，又停住。", "Shiba doing a miniature zoomie", "bounce", ["active", "play"]),
  state("soft_belly_breathe", "肚皮起伏", "Papo 趴着睡，肚皮轻轻起伏。", "Shiba sleeping with gentle belly breathing", "nap", ["sleep", "calm"]),
  state("listen_music", "听一点音乐", "Papo 安静听着一点声音，尾巴跟着慢慢动。", "Shiba listening to soft music", "listen", ["music", "calm"]),
  state("tiny_brave", "勇敢坐近", "Papo 鼓起一点勇气，坐得更近了。", "Shiba bravely sitting closer", "wag", ["trust", "attached"]),
  state("soft_question_face", "像有问题", "Papo 露出像有小问题的表情。", "Shiba with a gentle questioning face", "peek", ["curious", "ask"]),
  state("watch_cursor", "看光标动", "Papo 盯着屏幕上的小动静看。", "Shiba watching a cursor move on screen", "peek", ["screen", "curious"]),
  state("paws_together", "爪子并好", "Papo 把两只前爪并得整整齐齐。", "Shiba sitting with front paws neatly together", "idle", ["polite", "cute"]),
  state("soft_tail_thump", "尾巴轻拍", "Papo 的尾巴轻轻拍了两下地面。", "Shiba tail softly thumping the floor", "wag", ["happy", "calm"]),
  state("tiny_mischief", "有点调皮", "Papo 眼神亮了一下，像想到一点调皮事。", "Shiba with a tiny mischievous sparkle", "play", ["mischief", "active"]),
  state("deep_rest", "沉沉休息", "Papo 沉沉趴着，像需要安静充电。", "Shiba deeply resting in a quiet pose", "nap", ["rest", "low_energy"]),
  state("bright_hello", "精神地打招呼", "Papo 精神地抬起头，像在跟你打招呼。", "Shiba bright greeting with raised head", "bounce", ["greet", "bright"]),
  state("calm_presence", "安静存在", "Papo 安安静静待在这里，像一盏小灯。", "Shiba calm presence like a warm little light", "idle", ["calm", "presence"]),
  state("ready_for_walk", "像要出门", "Papo 站起来看向前方，像准备出门散步。", "Shiba ready for a walk", "bounce", ["walk", "active"]),
  state("soft_return", "又回到身边", "Papo 绕了一小圈，又回到你身边。", "Shiba circling back to user's side", "wag", ["attached", "return"])
];

const dogStateSchema = z.object({
  stateId: z.string().min(1).max(80),
  reason: z.string().min(1).max(260),
  nextCheckMinutes: z.number().int().min(20).max(180).optional()
});

function state(
  id: string,
  label: string,
  actionText: string,
  visualPrompt: string,
  animation: DogInteractionState["animation"] | "walk",
  tags: string[]
): DogStateCatalogItem {
  return {
    id,
    label,
    actionText,
    visualPrompt,
    animation: animation === "walk" ? "bounce" : animation,
    tags
  };
}

export function seedDogState(now = new Date().toISOString()): DogInteractionState {
  return dogStateFromCatalog(requireDogState("calm_presence"), now, "seed", "初始状态，等待 LLM 定时选择更贴合的外显状态。", DOG_STATE_CHECK_INTERVAL_MINUTES);
}

export function normalizeDogState(state: DogInteractionState | undefined, now = new Date().toISOString()) {
  if (!state) return seedDogState(now);
  const catalog = DOG_STATE_CATALOG.find((item) => item.id === state.id) ?? DOG_STATE_CATALOG.find((item) => item.id === state.id.replace(/^dog_/, ""));
  if (!catalog) return seedDogState(now);
  return {
    ...state,
    label: catalog.label,
    actionText: catalog.actionText,
    visualPrompt: catalog.visualPrompt,
    animation: catalog.animation,
    nextCheckAt: state.nextCheckAt ?? addMinutes(state.selectedAt ?? now, DOG_STATE_CHECK_INTERVAL_MINUTES),
    selectedBy: state.selectedBy ?? "seed"
  };
}

export function isDogStateCheckDue(profile: CreatureProfile, now = new Date().toISOString()) {
  const next = Date.parse(profile.dogState?.nextCheckAt ?? now);
  return !profile.dogState || !Number.isFinite(next) || next <= Date.parse(now);
}

export async function refreshDogStateIfDue(
  profile: CreatureProfile,
  provider: ModelProvider,
  input: { now?: string; force?: boolean } = {}
) {
  const now = input.now ?? new Date().toISOString();
  if (!input.force && !isDogStateCheckDue(profile, now)) return undefined;
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for dog state selection.");

  const raw = await provider.generateJson<unknown>(buildDogStatePrompt(profile, now));
  const parsed = dogStateSchema.safeParse(raw);
  if (!parsed.success) {
    recordDogStateRun(profile, provider, now, "invalid", `invalid dog state JSON: ${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 160)}`);
    throw new Error("invalid dog state model result");
  }

  const selectableStates = selectableDogStates(profile);
  const selected = selectableStates.find((item) => item.id === parsed.data.stateId);
  if (!selected) {
    recordDogStateRun(profile, provider, now, "invalid", `dog state model selected unknown state: ${parsed.data.stateId}`);
    throw new Error(`unknown dog state: ${parsed.data.stateId}`);
  }

  const minutes = parsed.data.nextCheckMinutes ?? DOG_STATE_CHECK_INTERVAL_MINUTES;
  const next = dogStateFromCatalog(selected, now, "llm", parsed.data.reason, minutes);
  profile.dogState = next;
  profile.dogStateHistory.unshift(next);
  profile.dogStateHistory = profile.dogStateHistory.slice(0, 40);
  recordDogStateRun(profile, provider, now, "applied", `llm selected dog state ${selected.id}`);
  return next;
}

export function applyActionCardState(profile: CreatureProfile, stateId: string | undefined, now = new Date().toISOString()) {
  if (!stateId) return undefined;
  const selected = DOG_STATE_CATALOG.find((item) => item.id === stateId);
  if (!selected) return undefined;
  const next = dogStateFromCatalog(selected, now, "action_card", "新动作卡完成后，首页状态与这张卡的画面和文字保持一致。", DOG_STATE_CHECK_INTERVAL_MINUTES);
  profile.dogState = next;
  profile.dogStateHistory.unshift(next);
  profile.dogStateHistory = profile.dogStateHistory.slice(0, 40);
  return next;
}

export function reconcileActionCardState(profile: CreatureProfile, now = new Date().toISOString()) {
  const enabledCards = (profile.actionCards ?? []).filter((card) =>
    !card.deleted && (card.displayMode ?? (card.disabled ? "disabled" : "dynamic")) !== "disabled"
  );
  const enabledStateIds = new Set(enabledCards.map((card) => card.stateId).filter((id): id is string => Boolean(id)));
  if (enabledStateIds.has(profile.dogState.id)) return profile.dogState;

  const nextStateId = enabledCards.find((card) => card.stateId && DOG_STATE_CATALOG.some((state) => state.id === card.stateId))?.stateId;
  const selected = DOG_STATE_CATALOG.find((state) => state.id === nextStateId)
    ?? requireDogState("calm_presence");
  const reason = nextStateId
    ? "动作卡展示范围变化后，首页切换到仍然启用的状态卡。"
    : "当前没有可绑定的启用动作卡，首页回到中性的安静状态。";
  const next = dogStateFromCatalog(selected, now, "action_card", reason, DOG_STATE_CHECK_INTERVAL_MINUTES);
  profile.dogState = next;
  profile.dogStateHistory.unshift(next);
  profile.dogStateHistory = profile.dogStateHistory.slice(0, 40);
  return next;
}

function selectableDogStates(profile: CreatureProfile) {
  const enabledStateIds = new Set((profile.actionCards ?? [])
    .filter((card) => !card.deleted && (card.displayMode ?? (card.disabled ? "disabled" : "dynamic")) !== "disabled" && card.stateId)
    .map((card) => card.stateId));
  const represented = DOG_STATE_CATALOG.filter((state) => enabledStateIds.has(state.id));
  return represented.length ? represented : DOG_STATE_CATALOG;
}

export function applyPetTouchState(profile: CreatureProfile, action: PetTouchAction, now = new Date().toISOString()) {
  markMeaningfulUserActivity(profile, now);
  const stateId = petTouchStateId(action);
  if (!stateId) return undefined;
  const selected = requireDogState(stateId);
  const next = dogStateFromCatalog(selected, now, "touch", "用户戳了戳小动物，界面把这次外显动作记为当前状态。", action === "nap" ? 45 : 30);
  profile.dogState = next;
  profile.dogStateHistory.unshift(next);
  profile.dogStateHistory = profile.dogStateHistory.slice(0, 40);
  return next;
}

function petTouchStateId(action: PetTouchAction) {
  switch (action) {
    case "play-ball":
      return "ball_ready";
    case "nap":
      return "sleepy_curl";
    case "idle":
      return "calm_presence";
    case "poke-wave":
    default:
      return undefined;
  }
}

function dogStateFromCatalog(
  item: DogStateCatalogItem,
  now: string,
  selectedBy: DogInteractionState["selectedBy"],
  reason: string,
  nextCheckMinutes: number
): DogInteractionState {
  return {
    id: item.id,
    selectedAt: now,
    label: item.label,
    actionText: item.actionText,
    visualPrompt: item.visualPrompt,
    animation: item.animation,
    reason,
    nextCheckAt: addMinutes(now, nextCheckMinutes),
    selectedBy
  };
}

function requireDogState(id: string) {
  const item = DOG_STATE_CATALOG.find((state) => state.id === id);
  if (!item) throw new Error(`Missing dog state ${id}`);
  return item;
}

function recordDogStateRun(profile: CreatureProfile, provider: ModelProvider, now: string, status: "applied" | "invalid" | "failed", message: string) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: now,
    source: "dog_state",
    stage: "dog_state",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=dog_state", `status=${status}`]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildDogStatePrompt(profile: CreatureProfile, now: string) {
  const selectableStates = selectableDogStates(profile);
  return `请作为 Papo 的外显状态选择脑，从 dog_state_catalog 中选择 Papo 接下来 1 小时左右在界面上呈现的状态。

目标：
- 这不是对用户说话，而是选择 Papo 当前在做什么、画面是什么、身体动作是什么。
- 不要选择内部心理流程，不要写规则说明，不要证明机制存在。
- 根据 pet_context 里的小动物类型、北京时间/配置时区、最近对话、长期记忆、当前状态和性格倾向，选一个自然的小动物外显状态。
- catalog 是通用动作语义库，部分 visualPrompt 仍以 Shiba 为默认参考；如果 pet_context 不是柴犬，要把动作理解为对应小动物的外显行为，不要在 reason 里把它说成小狗或柴犬。
- 如果用户刚互动较多，可以更贴近、听着、等待；如果长时间无互动，可以晒太阳、睡觉、玩球、看窗外等。
- 必须从本次提供的 catalog 里选择已有 stateId，不能新造。有动作卡时 catalog 会收敛为用户已启用的静态/动态卡所代表的状态，选择结果将直接决定首页画面与文字。
- nextCheckMinutes 通常 60；如果状态很短可以 30-45，如果适合久一点可以 90-120。

返回严格 JSON：
{"stateId":"curious_peek","reason":"为什么这个外显状态现在合适","nextCheckMinutes":60}

time_context:
${JSON.stringify(modelTimeContext(now))}

pet_context:
${JSON.stringify(modelPetContext(profile, now))}

current_numeric_state:
${JSON.stringify(profile.state)}

current_policy:
${JSON.stringify(profile.policyProfile)}

current_dog_state:
${JSON.stringify(profile.dogState)}

recent_memories:
${JSON.stringify(modelMemoryContext(profile.longTermMemories, { limit: 8 }))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile, 8))}

dog_state_catalog:
${JSON.stringify(selectableStates.map((item) => ({
  id: item.id,
  label: item.label,
  actionText: item.actionText,
  visualPrompt: item.visualPrompt,
  animation: item.animation,
  tags: item.tags
})))}
`;
}
