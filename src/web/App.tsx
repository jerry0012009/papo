import {
  Brain,
  Check,
  CircleOff,
  Eye,
  History,
  Lightbulb,
  MessageCircle,
  Plus,
  RefreshCcw,
  Save,
  Sparkles,
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AttentionEvent,
  CaptureResult,
  CreatureProfile,
  CreatureState,
  EpisodeMemory,
  FeedbackKind,
  SegmentKind,
  StreamSegment
} from "../core/types";
import {
  activeEmergence,
  buttonCapture,
  createProfile,
  curiousCapture,
  getProfile,
  getProvider,
  listProfiles,
  makeSegment,
  sendFeedback,
  updateLongTermMemory,
  type ProfileSummary,
  type ProviderInfo
} from "./api";

type Tab = "home" | "capture" | "curious" | "memory" | "brain" | "profile";

const feedbacks: Array<{ kind: FeedbackKind; label: string; icon: typeof Check }> = [
  { kind: "understood", label: "理解对了", icon: Check },
  { kind: "continue", label: "继续想", icon: Lightbulb },
  { kind: "not_now", label: "这次不用", icon: CircleOff },
  { kind: "remember", label: "记住", icon: Save },
  { kind: "forget", label: "忘掉", icon: RefreshCcw }
];

const starterSegments: Array<{ kind: SegmentKind; label: string; content: string }> = [
  {
    kind: "text",
    label: "片段 1",
    content: "这个 demo 不能只是一个记忆库，它要像一个有小脑袋的小动物，会自己注意到重点。"
  },
  {
    kind: "image_summary",
    label: "截图摘要 2",
    content: "竞品页面展示了自动总结、知识库和提醒功能，但看起来更像效率工具。"
  },
  {
    kind: "audio_transcript",
    label: "录音转写 3",
    content: "我担心投资人看完以后觉得这只是普通聊天机器人，所以要让反馈后真的有变化。"
  }
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [provider, setProvider] = useState<ProviderInfo>();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profile, setProfile] = useState<CreatureProfile>();
  const [buttonText, setButtonText] = useState("我希望这个 AI 小动物先学会注意我反复强调的核心主题，而不是急着做很多工具功能。");
  const [segments, setSegments] = useState(
    starterSegments.map((segment, index) => makeSegment(`segment-${index + 1}`, segment.kind, segment.label, segment.content))
  );
  const [lastResult, setLastResult] = useState<CaptureResult>();
  const [emergence, setEmergence] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const selectedEpisode = lastResult?.episodes[0] ?? profile?.episodes[0];

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    try {
      setBusy(true);
      const [providerInfo, existingProfiles] = await Promise.all([getProvider(), listProfiles()]);
      setProvider(providerInfo);
      let nextProfiles = existingProfiles;
      let active = existingProfiles[0] ? await getProfile(existingProfiles[0].userId) : undefined;
      if (!active) {
        active = await createProfile("Papo");
        nextProfiles = await listProfiles();
      }
      setProfiles(nextProfiles);
      setProfile(active);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function selectProfile(userId: string) {
    setProfile(await getProfile(userId));
    setTab("home");
  }

  async function addProfile() {
    const name = `Papo ${profiles.length + 1}`;
    const next = await createProfile(name);
    setProfiles(await listProfiles());
    setProfile(next);
  }

  async function submitButtonCapture() {
    if (!profile || !buttonText.trim()) return;
    await run(async () => {
      const result = await buttonCapture(profile.userId, buttonText);
      setLastResult(result);
      setProfile(result.profile);
      setTab("home");
    });
  }

  async function submitCurious() {
    if (!profile) return;
    await run(async () => {
      const result = await curiousCapture(
        profile.userId,
        segments.filter((segment) => segment.content.trim())
      );
      setLastResult(result);
      setProfile(result.profile);
      setTab("home");
    });
  }

  async function giveFeedback(kind: FeedbackKind, targetId?: string) {
    if (!profile) return;
    await run(async () => {
      const next = await sendFeedback(profile.userId, kind, targetId);
      setProfile(next);
      setLastResult((current) => (current ? { ...current, profile: next } : current));
    });
  }

  async function editLongTermMemory(memoryId: string, text: string) {
    if (!profile) return;
    await run(async () => {
      const next = await updateLongTermMemory(profile.userId, memoryId, text);
      setProfile(next);
    });
  }

  async function askEmergence() {
    if (!profile) return;
    await run(async () => {
      const result = await activeEmergence(profile.userId);
      setProfile(result.profile);
      setEmergence(result.emergence.text);
      setTab("home");
    });
  }

  async function run(action: () => Promise<void>) {
    try {
      setBusy(true);
      setError(undefined);
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!profile) {
    return (
      <main className="shell loading">
        <div className="creature idle" />
        <p>{busy ? "Papo 正在醒来" : error ?? "无法载入小动物"}</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <button className="icon-button" onClick={() => setTab("profile")} aria-label="切换用户">
          <UserRound size={19} />
        </button>
        <div>
          <p className="eyebrow">{provider?.name ?? "Fallback demo brain"}</p>
          <h1>{profile.creatureName}</h1>
          {provider?.usesRealModel ? <p className="eyebrow">LLM 语义脑已配置</p> : null}
        </div>
        <button className="icon-button" onClick={askEmergence} disabled={busy} aria-label="它现在在想什么">
          <Sparkles size={19} />
        </button>
      </header>

      {error ? <div className="notice">{error}</div> : null}

      {tab === "home" ? (
        <HomeView
          profile={profile}
          lastResult={lastResult}
          selectedEpisode={selectedEpisode}
          emergence={emergence}
          busy={busy}
          onFeedback={giveFeedback}
          onGoCapture={() => setTab("capture")}
          onGoCurious={() => setTab("curious")}
        />
      ) : null}

      {tab === "capture" ? (
        <CaptureView value={buttonText} onChange={setButtonText} onSubmit={submitButtonCapture} busy={busy} />
      ) : null}

      {tab === "curious" ? (
        <CuriousView segments={segments} setSegments={setSegments} onSubmit={submitCurious} busy={busy} />
      ) : null}

      {tab === "memory" ? <MemoryView profile={profile} onFeedback={giveFeedback} onEditMemory={editLongTermMemory} /> : null}
      {tab === "brain" ? <BrainView profile={profile} /> : null}
      {tab === "profile" ? <ProfileView profiles={profiles} activeId={profile.userId} onSelect={selectProfile} onAdd={addProfile} /> : null}

      <nav className="nav">
        <NavButton active={tab === "home"} icon={Eye} label="首页" onClick={() => setTab("home")} />
        <NavButton active={tab === "capture"} icon={MessageCircle} label="输入" onClick={() => setTab("capture")} />
        <NavButton active={tab === "curious"} icon={Sparkles} label="陪我" onClick={() => setTab("curious")} />
        <NavButton active={tab === "memory"} icon={History} label="记忆" onClick={() => setTab("memory")} />
        <NavButton active={tab === "brain"} icon={Brain} label="脑态" onClick={() => setTab("brain")} />
      </nav>
    </main>
  );
}

function HomeView(props: {
  profile: CreatureProfile;
  lastResult?: CaptureResult;
  selectedEpisode?: EpisodeMemory;
  emergence?: string;
  busy: boolean;
  onFeedback: (kind: FeedbackKind, targetId?: string) => void;
  onGoCapture: () => void;
  onGoCurious: () => void;
}) {
  return (
    <section className="stack">
      <div className="hero">
        <div className={`creature mood-${props.profile.state.mood}`} aria-label="小动物头像">
          <span />
        </div>
        <div className="hero-copy">
          <p className="eyebrow">当前心情</p>
          <h2>{moodText(props.profile.state.mood)}</h2>
          <p>{stateSentence(props.profile.state)}</p>
        </div>
      </div>

      <div className="action-row">
        <button onClick={props.onGoCapture}>
          <MessageCircle size={18} />
          单次输入
        </button>
        <button onClick={props.onGoCurious}>
          <Sparkles size={18} />
          陪我一会儿
        </button>
      </div>

      {props.emergence ? <section className="memory-surface active">{props.emergence}</section> : null}

      <StateGrid state={props.profile.state} />

      {props.lastResult ? (
        <section className="panel">
          <PanelTitle icon={Eye} title="刚才的注意事件" />
          <p className="response">{props.lastResult.response}</p>
          {props.lastResult.harnessTrace?.length ? (
            <div className="trace-line">{props.lastResult.harnessTrace.join(" -> ")}</div>
          ) : null}
          <div className="event-list">
            {props.lastResult.events.map((event) => (
              <AttentionCard key={event.id} event={event} />
            ))}
          </div>
        </section>
      ) : null}

      {props.selectedEpisode ? (
        <EpisodeCard episode={props.selectedEpisode} onFeedback={props.onFeedback} compact={false} />
      ) : null}
    </section>
  );
}

function CaptureView(props: { value: string; onChange: (value: string) => void; onSubmit: () => void; busy: boolean }) {
  return (
    <section className="panel">
      <PanelTitle icon={MessageCircle} title="Button Capture" />
      <textarea value={props.value} onChange={(event) => props.onChange(event.target.value)} rows={8} />
      <button className="primary" onClick={props.onSubmit} disabled={props.busy || !props.value.trim()}>
        <Eye size={18} />
        让它认真注意
      </button>
    </section>
  );
}

function CuriousView(props: {
  segments: StreamSegment[];
  setSegments: (segments: StreamSegment[]) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  function updateSegment(index: number, patch: Partial<StreamSegment>) {
    props.setSegments(props.segments.map((segment, current) => (current === index ? { ...segment, ...patch } : segment)));
  }

  function addSegment() {
    props.setSegments([
      ...props.segments,
      makeSegment(`segment-${Date.now()}`, "text", `片段 ${props.segments.length + 1}`, "")
    ]);
  }

  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={Sparkles} title="Curious Mode" />
        {props.segments.map((segment, index) => (
          <div className="segment-editor" key={segment.id}>
            <div className="segment-row">
              <input value={segment.label} onChange={(event) => updateSegment(index, { label: event.target.value })} />
              <select value={segment.kind} onChange={(event) => updateSegment(index, { kind: event.target.value as SegmentKind })}>
                <option value="text">文字</option>
                <option value="image_summary">截图摘要</option>
                <option value="audio_transcript">录音转写</option>
              </select>
            </div>
            <textarea value={segment.content} onChange={(event) => updateSegment(index, { content: event.target.value })} rows={4} />
          </div>
        ))}
        <div className="action-row">
          <button onClick={addSegment}>
            <Plus size={18} />
            加片段
          </button>
          <button className="primary" onClick={props.onSubmit} disabled={props.busy}>
            <Eye size={18} />
            开始观察
          </button>
        </div>
      </div>
    </section>
  );
}

function MemoryView(props: {
  profile: CreatureProfile;
  onFeedback: (kind: FeedbackKind, targetId?: string) => void;
  onEditMemory: (memoryId: string, text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const memories = props.profile.longTermMemories.filter((memory) =>
    `${memory.text} ${memory.kind} ${memory.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={History} title="长期记忆" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索旧记忆" />
        {memories.map((memory) => (
          <article className="memory-surface" key={memory.id}>
            {editingId === memory.id ? (
              <>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} />
                <div className="memory-actions">
                  <button
                    className="primary"
                    onClick={() => {
                      props.onEditMemory(memory.id, draft);
                      setEditingId(undefined);
                    }}
                  >
                    <Save size={16} />
                    保存
                  </button>
                  <button onClick={() => setEditingId(undefined)}>取消</button>
                </div>
              </>
            ) : (
              <p>{memory.text}</p>
            )}
            <span>{memory.kind} · 权重 {memory.weight}</span>
            <div className="memory-actions">
              <button
                onClick={() => {
                  setEditingId(memory.id);
                  setDraft(memory.text);
                }}
              >
                <MessageCircle size={16} />
                修改
              </button>
              <button onClick={() => props.onFeedback("forget", memory.id)}>
                <RefreshCcw size={16} />
                忘掉
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="panel">
        <PanelTitle icon={Eye} title="情景记忆" />
        {props.profile.episodes.map((episode) => (
          <EpisodeCard key={episode.id} episode={episode} onFeedback={props.onFeedback} compact />
        ))}
      </div>
    </section>
  );
}

function BrainView({ profile }: { profile: CreatureProfile }) {
  return (
    <section className="stack">
      <StateGrid state={profile.state} />
      <div className="panel">
        <PanelTitle icon={Brain} title="最近变化" />
        {profile.stateChanges.length ? (
          profile.stateChanges.map((change) => (
            <article className="change-row" key={`${change.at}-${change.reason}`}>
              <p>{change.reason}</p>
              <span>{new Date(change.at).toLocaleString("zh-CN")}</span>
            </article>
          ))
        ) : (
          <p className="muted">还没有反馈造成的状态变化。</p>
        )}
      </div>
      <div className="panel">
        <PanelTitle icon={Check} title="反馈历史" />
        {profile.feedbackHistory.map((feedback) => (
          <article className="change-row" key={feedback.id}>
            <p>{feedback.effect}</p>
            <span>{feedback.kind}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProfileView(props: {
  profiles: ProfileSummary[];
  activeId: string;
  onSelect: (userId: string) => void;
  onAdd: () => void;
}) {
  return (
    <section className="panel">
      <PanelTitle icon={UserRound} title="小动物切换" />
      <div className="profile-list">
        {props.profiles.map((profile) => (
          <button
            className={profile.userId === props.activeId ? "profile-pill active" : "profile-pill"}
            key={profile.userId}
            onClick={() => props.onSelect(profile.userId)}
          >
            <UserRound size={18} />
            <span>{profile.creatureName}</span>
          </button>
        ))}
      </div>
      <button className="primary" onClick={props.onAdd}>
        <Plus size={18} />
        新建小动物
      </button>
    </section>
  );
}

function AttentionCard({ event }: { event: AttentionEvent }) {
  return (
    <article className="attention-card">
      <div>
        <span>{event.triggerLabel}</span>
        <strong>{event.attentionStrength}</strong>
      </div>
      <p>{event.noticed}</p>
      <small>{event.reason}</small>
      <footer>
        <span>{actionText(event.suggestedAction)}</span>
        <span>隐私 {event.privacyRisk}</span>
      </footer>
    </article>
  );
}

function EpisodeCard(props: {
  episode: EpisodeMemory;
  compact: boolean;
  onFeedback: (kind: FeedbackKind, targetId?: string) => void;
}) {
  return (
    <article className="episode-card">
      <div className="episode-head">
        <span>{props.episode.source === "button" ? "Button" : "Curious"}</span>
        <strong>权重 {props.episode.weight}</strong>
      </div>
      <h3>{props.episode.noticed}</h3>
      {!props.compact ? <p>{props.episode.creatureResponse}</p> : null}
      <small>{props.episode.importanceReason}</small>
      {props.episode.decisionTrace?.length && !props.compact ? (
        <small>{props.episode.decisionTrace.join(" -> ")}</small>
      ) : null}
      <div className="feedback-row">
        {feedbacks.map((item) => (
          <button key={item.kind} onClick={() => props.onFeedback(item.kind, props.episode.id)} aria-label={item.label}>
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
    </article>
  );
}

function StateGrid({ state }: { state: CreatureState }) {
  const rows = useMemo(
    () => [
      ["好奇心", state.curiosity],
      ["依恋度", state.attachment],
      ["精力", state.energy],
      ["唤醒度", state.arousal],
      ["安全感", state.safety],
      ["表达自信", state.confidence]
    ],
    [state]
  );
  return (
    <section className="state-grid">
      {rows.map(([label, value]) => (
        <div className="state-item" key={label}>
          <div>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
          <meter min={0} max={100} value={Number(value)} />
        </div>
      ))}
    </section>
  );
}

function PanelTitle({ icon: Icon, title }: { icon: typeof Brain; title: string }) {
  return (
    <div className="panel-title">
      <Icon size={18} />
      <h2>{title}</h2>
    </div>
  );
}

function NavButton(props: { active: boolean; icon: typeof Brain; label: string; onClick: () => void }) {
  return (
    <button className={props.active ? "active" : ""} onClick={props.onClick}>
      <props.icon size={19} />
      <span>{props.label}</span>
    </button>
  );
}

function moodText(mood: CreatureState["mood"]) {
  const map = {
    curious: "好奇地贴近",
    calm: "安静地陪着",
    attached: "更想靠近你",
    careful: "谨慎地观察",
    tired: "有点低电量",
    bright: "亮起来了"
  };
  return map[mood];
}

function stateSentence(state: CreatureState) {
  if (state.energy < 35) return "它会短一点回应，把重要片段先存下来。";
  if (state.safety > 74) return "它会更谨慎处理隐私和长期保存。";
  if (state.curiosity > 72) return "它更容易从信息流里挑出新主题。";
  if (state.attachment > 68) return "它更愿意把当前片段和你们的旧经历连起来。";
  return "它正在用稳定的注意力观察当前片段。";
}

function actionText(action: AttentionEvent["suggestedAction"]) {
  const map = {
    observe: "观察",
    ask: "轻问",
    save_episode: "存情景",
    save_long_term: "存长期",
    recall: "回忆",
    review: "复盘",
    quiet: "安静"
  };
  return map[action];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "发生未知错误";
}
