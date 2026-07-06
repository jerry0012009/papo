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
  Wand2,
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  wakeProfile,
  type ProfileSummary,
  type ProviderInfo
} from "./api";

type Tab = "home" | "capture" | "curious" | "memory" | "brain" | "profile" | "demo";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

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
    label: "早晨记录",
    content: "今天早上只是匆匆吃了面包，没发生什么特别的事。"
  },
  {
    kind: "image_summary",
    label: "日历截图",
    content: "日历里标着周五 9:30 妈妈复查，旁边还有准备病历和医保卡的备注。"
  },
  {
    kind: "audio_transcript",
    label: "语音转写",
    content: "我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。"
  }
];

const demoCuriousSegments: Array<{ kind: SegmentKind; label: string; content: string }> = [
  { kind: "text", label: "背景 1", content: "今天早餐吃了面包，路上有点堵。" },
  { kind: "image_summary", label: "日历截图", content: "周五 9:30 妈妈复查，备注写着提前准备病历、医保卡和上次检查单。" },
  { kind: "text", label: "隐私片段", content: "短信里有一个验证码 4921 和缴费链接，这段不应该被长期保存。" },
  { kind: "audio_transcript", label: "语音 1", content: "我有点担心自己又把妈妈复查这件事拖到最后，明明很重要。" },
  { kind: "image_summary", label: "购物截图", content: "购物车里有洗衣液、纸巾和一个水杯。" },
  { kind: "text", label: "朋友提醒", content: "朋友说我最近总是把重要家事压到睡前才处理，容易焦虑。" },
  { kind: "audio_transcript", label: "语音 2", content: "下周想提前一天提醒自己准备资料，不要又临时找东西。" },
  { kind: "text", label: "重复背景", content: "妈妈复查这件事刚才已经说过一次，这里只是重复提醒。" }
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [provider, setProvider] = useState<ProviderInfo>();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profile, setProfile] = useState<CreatureProfile>();
  const [buttonText, setButtonText] = useState("我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要，但我最近总是这样。");
  const [segments, setSegments] = useState(
    starterSegments.map((segment, index) => makeSegment(`segment-${index + 1}`, segment.kind, segment.label, segment.content))
  );
  const [lastResult, setLastResult] = useState<CaptureResult>();
  const [emergence, setEmergence] = useState<string>();
  const [learningNote, setLearningNote] = useState<string>();
  const [wakeMessage, setWakeMessage] = useState<string>();
  const [wakeThought, setWakeThought] = useState<string>();
  const [demoNote, setDemoNote] = useState<string>();
  const [listening, setListening] = useState(false);
  const [listeningElapsed, setListeningElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptBufferRef = useRef("");
  const segmentIndexRef = useRef(1);
  const listeningStartedAtRef = useRef<number | undefined>(undefined);
  const tickTimerRef = useRef<number | undefined>(undefined);
  const segmentTimerRef = useRef<number | undefined>(undefined);
  const stopTimerRef = useRef<number | undefined>(undefined);

  const selectedEpisode = lastResult?.episodes[0] ?? profile?.episodes[0];

  useEffect(() => {
    void bootstrap();
    return () => stopListening();
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
      const woke = await wakeProfile(active.userId);
      setProfiles(nextProfiles);
      setProfile(woke.profile);
      setWakeMessage(woke.wake.message);
      setWakeThought(woke.wake.innerThought);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function selectProfile(userId: string) {
    const active = await getProfile(userId);
    const woke = await wakeProfile(active.userId);
    setProfile(woke.profile);
    setWakeMessage(woke.wake.message);
    setWakeThought(woke.wake.innerThought);
    setTab("home");
  }

  async function addProfile() {
    const name = `Papo ${profiles.length + 1}`;
    const next = await createProfile(name);
    setProfiles(await listProfiles());
    const woke = await wakeProfile(next.userId);
    setProfile(woke.profile);
    setWakeMessage(woke.wake.message);
    setWakeThought(woke.wake.innerThought);
  }

  async function submitButtonCapture() {
    if (!profile || !buttonText.trim()) return;
    await run(async () => {
      const result = await buttonCapture(profile.userId, buttonText);
      setLastResult(result);
      setProfile(result.profile);
      setLearningNote(undefined);
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
      setLearningNote(undefined);
      setTab("home");
    });
  }

  async function giveFeedback(kind: FeedbackKind, targetId?: string) {
    if (!profile) return;
    await run(async () => {
      const { profile: next, feedback } = await sendFeedback(profile.userId, kind, targetId);
      setProfile(next);
      setLearningNote(feedback.learningNote);
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

  async function startListening() {
    if (listening) return;
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setError("当前浏览器不支持实时语音转写。可以继续用文字或手动粘贴录音转写。");
      return;
    }

    try {
      await navigator.mediaDevices?.getUserMedia?.({ audio: true });
    } catch {
      setError("没有拿到麦克风权限。可以继续用文字模拟一段信息流。");
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "zh-CN";
    transcriptBufferRef.current = "";
    segmentIndexRef.current = 1;
    listeningStartedAtRef.current = Date.now();
    setListeningElapsed(0);
    setListening(true);
    setError(undefined);

    recognition.onresult = (event) => {
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
      }
      if (finalText.trim()) transcriptBufferRef.current = `${transcriptBufferRef.current} ${finalText.trim()}`.trim();
    };
    recognition.onerror = (event) => {
      setError(`语音监听中断：${event.error ?? "未知错误"}`);
    };
    recognition.onend = () => {
      if (listeningStartedAtRef.current) {
        try {
          recognition.start();
        } catch {
          // Some browsers throw if restart happens too quickly.
        }
      }
    };
    recognitionRef.current = recognition;
    recognition.start();

    tickTimerRef.current = window.setInterval(() => {
      if (!listeningStartedAtRef.current) return;
      setListeningElapsed(Math.min(180, Math.floor((Date.now() - listeningStartedAtRef.current) / 1000)));
    }, 1000);
    segmentTimerRef.current = window.setInterval(() => flushAudioTranscriptSegment(false), 30_000);
    stopTimerRef.current = window.setTimeout(() => stopListening(), 180_000);
  }

  function stopListening() {
    flushAudioTranscriptSegment(true);
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (tickTimerRef.current) window.clearInterval(tickTimerRef.current);
    if (segmentTimerRef.current) window.clearInterval(segmentTimerRef.current);
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    tickTimerRef.current = undefined;
    segmentTimerRef.current = undefined;
    stopTimerRef.current = undefined;
    listeningStartedAtRef.current = undefined;
    setListening(false);
  }

  function flushAudioTranscriptSegment(force: boolean) {
    const content = transcriptBufferRef.current.trim();
    if (!content && !force) return;
    if (!content) return;
    const index = segmentIndexRef.current;
    segmentIndexRef.current += 1;
    transcriptBufferRef.current = "";
    setSegments((current) => [
      ...current,
      makeSegment(`live-audio-${Date.now()}-${index}`, "audio_transcript", `语音片段 ${index}`, content)
    ]);
  }

  function loadDemoCurious() {
    setSegments(demoCuriousSegments.map((segment, index) => makeSegment(`demo-${index + 1}`, segment.kind, segment.label, segment.content)));
    setDemoNote("我已经放入 8 段生活化信息流：背景、日历、隐私、语音和重复片段。下一步点“开始观察”。");
    setTab("curious");
  }

  async function runDemoContrast() {
    await run(async () => {
      const input = "我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。";
      const a = await createProfile("Papo 深想型");
      const b = await createProfile("Papo 安静型");
      const aFirst = await buttonCapture(a.userId, input);
      const bFirst = await buttonCapture(b.userId, input);
      let aProfile = aFirst.profile;
      let bProfile = bFirst.profile;
      for (let i = 0; i < 3; i += 1) {
        aProfile = (await sendFeedback(a.userId, "continue", aFirst.episodes[0].id)).profile;
        bProfile = (await sendFeedback(b.userId, "not_now", bFirst.episodes[0].id)).profile;
      }
      const aResult = await buttonCapture(a.userId, input);
      await buttonCapture(b.userId, input);
      setProfiles(await listProfiles());
      setProfile(aResult.profile);
      setLastResult(aResult);
      setLearningNote("A 连续收到“继续想”，B 连续收到“这次不用”。同一句输入下，A 会更愿意展开，B 会更克制。");
      setDemoNote(`已创建两个小动物：${aProfile.creatureName} 和 ${bProfile.creatureName}。你可以去“小动物切换”查看差异。`);
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
          learningNote={learningNote}
          wakeMessage={wakeMessage}
          wakeThought={wakeThought}
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
        <CuriousView
          segments={segments}
          setSegments={setSegments}
          onSubmit={submitCurious}
          busy={busy}
          listening={listening}
          listeningElapsed={listeningElapsed}
          onStartListening={startListening}
          onStopListening={stopListening}
        />
      ) : null}

      {tab === "memory" ? <MemoryView profile={profile} onFeedback={giveFeedback} onEditMemory={editLongTermMemory} /> : null}
      {tab === "brain" ? <BrainView profile={profile} /> : null}
      {tab === "profile" ? <ProfileView profiles={profiles} activeId={profile.userId} onSelect={selectProfile} onAdd={addProfile} /> : null}
      {tab === "demo" ? <DemoView onLoadCurious={loadDemoCurious} onRunContrast={runDemoContrast} onEmerge={askEmergence} note={demoNote} busy={busy} /> : null}

      <nav className="nav">
        <NavButton active={tab === "home"} icon={Eye} label="首页" onClick={() => setTab("home")} />
        <NavButton active={tab === "capture"} icon={MessageCircle} label="输入" onClick={() => setTab("capture")} />
        <NavButton active={tab === "curious"} icon={Sparkles} label="陪我" onClick={() => setTab("curious")} />
        <NavButton active={tab === "memory"} icon={History} label="记忆" onClick={() => setTab("memory")} />
        <NavButton active={tab === "brain"} icon={Brain} label="脑态" onClick={() => setTab("brain")} />
        <NavButton active={tab === "demo"} icon={Wand2} label="演示" onClick={() => setTab("demo")} />
      </nav>
    </main>
  );
}

function HomeView(props: {
  profile: CreatureProfile;
  lastResult?: CaptureResult;
  selectedEpisode?: EpisodeMemory;
  emergence?: string;
  learningNote?: string;
  wakeMessage?: string;
  wakeThought?: string;
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

      {props.wakeMessage ? (
        <section className="wake-note">
          <span>醒来时</span>
          <p>{props.wakeMessage}</p>
          {props.wakeThought ? <p>{props.wakeThought}</p> : null}
        </section>
      ) : null}
      {props.emergence ? <section className="memory-surface active">{props.emergence}</section> : null}
      {props.learningNote ? <section className="learning-note">{props.learningNote}</section> : null}

      <StateGrid state={props.profile.state} />

      {props.lastResult ? (
        <section className="panel">
          <PanelTitle icon={Eye} title="刚才的注意事件" />
          <p className="response">{props.lastResult.response}</p>
          {props.lastResult.curiousSession ? (
            <div className="session-audit">
              <p>{props.lastResult.curiousSession.creatureReport}</p>
              {props.lastResult.curiousSession.ignored.slice(0, 4).map((item) => (
                <small key={item.segmentId}>
                  未选 {item.label}：{item.whyIgnored}
                </small>
              ))}
            </div>
          ) : null}
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
  setSegments: (segments: StreamSegment[] | ((current: StreamSegment[]) => StreamSegment[])) => void;
  onSubmit: () => void;
  busy: boolean;
  listening: boolean;
  listeningElapsed: number;
  onStartListening: () => void;
  onStopListening: () => void;
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
        <section className="listening-panel">
          <div>
            <strong>{props.listening ? "我正在听这一小段世界" : "语音陪伴实验"}</strong>
            <p>
              最多听 3 分钟，每 30 秒把语音转写切成一段。原始音频不保存，只把转写片段放进信息流。
            </p>
          </div>
          <button onClick={props.listening ? props.onStopListening : props.onStartListening} disabled={props.busy}>
            <Sparkles size={18} />
            {props.listening ? `停止 ${formatListeningTime(props.listeningElapsed)}` : "开始听 3 分钟"}
          </button>
        </section>
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
  const selfMemories = memories.filter((memory) => memory.kind === "creature_self_memory");
  const otherMemories = memories.filter((memory) => memory.kind !== "creature_self_memory");

  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={History} title="长期记忆" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索旧记忆" />
        {otherMemories.map((memory) => (
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
        <PanelTitle icon={Brain} title="小动物自己的成长记忆" />
        {selfMemories.map((memory) => (
          <article className="memory-surface" key={memory.id}>
            <p>{memory.text}</p>
            <span>{memory.consolidatedBecause ?? "creature_self_memory"} · 权重 {memory.weight}</span>
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
  const latestEpisode = profile.episodes[0];
  const latestEmergence = profile.emergenceHistory?.[0];
  return (
    <section className="stack">
      <StateGrid state={profile.state} />
      <div className="panel">
        <PanelTitle icon={Brain} title="反馈策略" />
        <div className="state-grid">
          {Object.entries(profile.policyProfile ?? {}).map(([key, value]) => (
            <div className="state-item" key={key}>
              <div>
                <span>{policyLabel(key)}</span>
                <strong>{value}</strong>
              </div>
              <meter min={0} max={100} value={Number(value)} />
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <PanelTitle icon={Eye} title="最近决策" />
        {latestEpisode?.actionDecision ? (
          <article className="change-row">
            <p>{actionText(latestEpisode.actionDecision.action)}：{latestEpisode.actionDecision.reason}</p>
            <span>{latestEpisode.actionDecision.ruleTrace.join(" -> ")}</span>
          </article>
        ) : (
          <p className="muted">还没有行动决策。</p>
        )}
      </div>
      <div className="panel">
        <PanelTitle icon={Sparkles} title="最近浮现" />
        {latestEmergence ? (
          <article className="change-row">
            <p>{latestEmergence.message}</p>
            <span>{latestEmergence.whyNow} · {latestEmergence.ruleTrace.join(" -> ")}</span>
          </article>
        ) : (
          <p className="muted">还没有主动浮现历史。</p>
        )}
      </div>
      <div className="panel">
        <PanelTitle icon={Save} title="记忆候选" />
        {(profile.memoryCandidates ?? []).slice(0, 5).map((candidate) => (
          <article className="change-row" key={candidate.id}>
            <p>{candidate.candidateText}</p>
            <span>{candidate.memoryKind} · {candidate.writePolicy} · confidence {candidate.confidence}</span>
          </article>
        ))}
      </div>
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

function DemoView(props: {
  onLoadCurious: () => void;
  onRunContrast: () => void;
  onEmerge: () => void;
  note?: string;
  busy: boolean;
}) {
  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={Wand2} title="演示模式" />
        <p className="response">用生活化素材演示三件事：它会从信息流里注意，它会被反馈养成，它会主动想起旧片段。</p>
        {props.note ? <section className="learning-note">{props.note}</section> : null}
        <button onClick={props.onLoadCurious} disabled={props.busy}>
          <Sparkles size={18} />
          场景 1：填入 8 段信息流
        </button>
        <button onClick={props.onRunContrast} disabled={props.busy}>
          <UserRound size={18} />
          场景 2：生成 A/B 养成对比
        </button>
        <button onClick={props.onEmerge} disabled={props.busy}>
          <Lightbulb size={18} />
          场景 3：让它现在想一想
        </button>
      </div>
      <div className="panel">
        <PanelTitle icon={Brain} title="后续任务" />
        <p className="response">Curious Mode 后续会加入持续录音：最多 3 分钟，每 30 秒自动切成一段 audio transcript，再作为注意素材进入同一套 session audit。</p>
      </div>
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
      <details className="brain-details">
        <summary>为什么它注意到了这个</summary>
        <div className="score-list">
          {event.scoreBreakdown?.contributions.map((item) => (
            <span key={`${event.id}-${item.label}-${item.reason}`}>
              {item.label} {item.value >= 0 ? "+" : ""}
              {item.value}: {item.reason}
            </span>
          ))}
        </div>
        <p>{event.actionDecision.reason}</p>
        {event.actionDecision.blockedActions.length ? (
          <p>被拦截：{event.actionDecision.blockedActions.map((item) => `${actionText(item.action)}: ${item.reason}`).join("；")}</p>
        ) : null}
      </details>
      <footer>
        <span>{actionText(event.actionDecision.action)} · {event.actionDecision.confidence}</span>
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
        <span>{props.episode.source === "button" ? "你递给我的片段" : "我自己注意到的片段"}</span>
        <strong>权重 {props.episode.weight}</strong>
      </div>
      <h3>{props.episode.creatureExperience?.earReason ?? props.episode.noticed}</h3>
      {!props.compact ? (
        <div className="episode-experience">
          <p><strong>我刚才注意到：</strong>{props.episode.noticed}</p>
          <p><strong>我为什么注意：</strong>{props.episode.creatureExperience?.earReason ?? props.episode.importanceReason}</p>
          <p><strong>我想起了什么：</strong>{props.episode.creatureExperience?.rememberedScene ?? "这次还没有强烈拉起旧片段。"}</p>
          <p><strong>我猜你在做：</strong>{props.episode.possibleIntent}</p>
          <p><strong>我当时的状态：</strong>{episodeStateText(props.episode)}</p>
          <p><strong>我选择：</strong>{props.episode.creatureExperience?.actionFeeling ?? props.episode.actionDecision?.reason}</p>
          <p><strong>要不要长期记：</strong>{props.episode.creatureExperience?.saveFeeling ?? "先作为情景记忆，等你的反馈决定。"}</p>
        </div>
      ) : null}
      {props.episode.decisionTrace?.length && !props.compact ? (
        <details className="brain-details">
          <summary>开发者 trace</summary>
          <small>{props.episode.decisionTrace.join(" -> ")}</small>
        </details>
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

function episodeStateText(episode: EpisodeMemory) {
  const state = episode.stateSnapshot;
  const parts = [];
  if (state.curiosity > 70) parts.push("好奇心比较高，所以更容易被新主题吸引");
  if (state.attachment > 60) parts.push("依恋度较高，所以更愿意联想旧记忆");
  if (state.energy < 35) parts.push("精力偏低，所以会短一点回应");
  if (state.safety > 70) parts.push("安全感偏谨慎，所以不会急着保存隐私内容");
  return parts.length ? parts.join("；") : "状态稳定，适合认真观察这一段";
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
    quiet: "安静",
    draft_reminder: "提醒草稿",
    draft_question_list: "问题清单"
  };
  return map[action];
}

function policyLabel(key: string) {
  const map: Record<string, string> = {
    preferDepth: "深入倾向",
    preferProactivity: "主动倾向",
    privacySensitivity: "隐私敏感",
    saveThreshold: "保存阈值",
    askThreshold: "询问阈值",
    recallTendency: "回忆倾向",
    quietTendency: "安静倾向"
  };
  return map[key] ?? key;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "发生未知错误";
}

function getSpeechRecognition(): SpeechRecognitionConstructor | undefined {
  const webWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return webWindow.SpeechRecognition ?? webWindow.webkitSpeechRecognition;
}

function formatListeningTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
