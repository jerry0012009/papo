# Papo

Papo 是一只 mobile-first 的 AI 柴犬小动物。它接收文字、照片、音频和持续陪伴时的 30 秒生活片段，由真实 LLM 决定如何注意、如何回应、如何记住、如何从反馈里改变。

Papo 不是本地规则 demo。没有真实模型配置时，认知链路会直接报错，不会伪造理解。

## 生命体 Agent Harness

当前 harness：

1. Sense：把对话、照片、音频或 30 秒共同片段整理成 observation。
2. Attention：LLM 从候选里决定是否注意，以及注意哪一个生活窗口。
3. Action：LLM 选择行动、外显回复、行为短句和关联记忆。
4. Memory：LLM 决定候选记忆文本、类型、标签和保存策略。
5. Feedback：用户反馈进入同一互动系统，LLM 反思状态、策略和记忆变化。
6. Emergence：LLM 决定是否主动浮现，以及浮现哪条真实记忆。

规则只负责工程骨架：

- 小动物状态初始化和状态范围约束
- 多用户隔离
- 输入窗口、source id 和候选结构
- 合法动作枚举
- 记忆持久化、删除和权重边界
- provider 错误暴露

LLM 负责具体判断和措辞：

- 理解用户说了什么、照片里有什么、音频里发生了什么
- 决定是否回应、追问、安静、记住、回忆或整理
- 写出 Papo 最终对用户说的话
- 写出记忆候选和标签
- 判断反馈意味着什么，以及下次如何变化

## 陪我

“陪我”会持续听一段时间，并按约 30 秒合并同一窗口里的音频、文字和照片。每个窗口独立进入 LLM 注意决策，不是本地规则从多段里挑几段。

## 运行

```bash
npm install
npm run dev
```

默认地址：

- Web: http://localhost:5173
- API: http://localhost:8787

公网：

- Web: https://eu.jerrypsy.top/papo/
- API health: https://eu.jerrypsy.top/papo-api/health

生产子路由构建：

```bash
VITE_BASE_PATH=/papo/ VITE_API_BASE=/papo-api npm run build
npm run serve:api
```

## Provider

Provider 配置来自环境变量、`.env`、`papo.config.json` 或 `.papo/provider.json`。

`PAPO_PROVIDER` 可显式指定 `openrouter`、`mimo` 或 `generic`。没有显式指定时，按 OpenRouter、Mimo、generic OpenAI-compatible 的顺序选择。若主文本供应商明确拒绝请求，Papo 会用中性的结构化任务视图重试，并在已有第二套供应商凭据时自动跨供应商回退。可用 `PAPO_TEXT_FALLBACK_PROVIDER=openrouter|mimo|generic` 显式指定，或设为 `none` 关闭跨供应商回退。

模型可按模态配置：

- `OPENROUTER_MODEL`
- `OPENROUTER_VISION_MODEL`
- `OPENROUTER_AUDIO_MODEL`
- `OPENROUTER_VIDEO_MODEL` defaults to `bytedance/seedance-1-5-pro` at 480P, four seconds, without audio for low-cost square action cards.
- `OPENAI_MODEL`
- `OPENAI_VISION_MODEL`
- `OPENAI_AUDIO_TRANSCRIPTION_MODEL`
- `PAPO_VIDEO_PROVIDER=dashscope` with `DASHSCOPE_API_KEY` is an optional direct Wan route. Without it, OpenRouter uses the low-cost Seedance default. See `docs/media-cost-routing.md` for reviewed costs and the quality gate.

OpenRouter 音频默认使用已验证的 `xiaomi/mimo-v2.5` multimodal chat route。Generic provider 仍可使用 `/audio/transcriptions` provider route，但那只是供应商兼容路径，不是 Papo 的业务语义。

## Hermes

`use_hermes` 是 LLM 行动选择的一种真实外部任务动作。常用配置：

- `PAPO_HERMES_DISPATCH=discord|cli`
- `PAPO_DISCORD_BOT_TOKEN`
- `PAPO_DISCORD_GUILD_ID`
- `PAPO_DISCORD_PARENT_CHANNEL_ID`

Discord 模式需要使用 Hermes Gateway 会当作用户输入处理的独立 Papo bot。复用 Hermes 自己的 bot token 只能发消息，不能触发 Hermes 处理自己的消息。当前服务器可用 `PAPO_HERMES_DISPATCH=cli` 走本机 Hermes 执行器。

CLI 模式使用 `hermes chat -Q --source tool`，不是一次性 `-z`。Papo 会为每个 `userId` 持久化独立 Hermes `sessionId/sessionName`，后续任务用 `--resume` 进入同一虾虾上下文，不同用户不会串线。

## 手机消息通知

Papo 支持标准 Web Push。Android Chrome 在 HTTPS 站点中打开“资料 -> 消息通知”后，Papo 的新回复、主动浮现和 Hermes 后台结果都可以在网页退到后台后显示为系统通知；当前页面可见时只同步消息，不重复弹通知。

服务端配置：

```bash
PAPO_WEB_PUSH_SUBJECT=https://your-papo-host.example/papo/
PAPO_WEB_PUSH_PUBLIC_KEY=your-vapid-public-key
PAPO_WEB_PUSH_PRIVATE_KEY=your-vapid-private-key
```

可用 `npx web-push generate-vapid-keys` 生成一对稳定的 VAPID 密钥。私钥不能提交到仓库；浏览器订阅保存在 `data/push-subscriptions.json`。更换 VAPID 密钥会使已有设备订阅失效，用户需要重新开启通知。

Web Push 不等于 Android 后台录音。Chrome 可以在页面退到后台后接收服务端已经生成的新消息，但 Android 仍可能冻结网页、暂停计时器或停止麦克风，因此 15/60 分钟“陪我”不能保证在锁屏或系统回收页面后持续采音。

## Android APK

APK 是同一套 React/Vite 产品代码的安卓容器，不维护第二套页面。只有浏览器无法提供的持续录音、后台相机、加密设备令牌和断网队列位于原生层。

```bash
npm run android:doctor
npm run apk:debug
npm run apk:release
```

产物位于 `artifacts/`。首次 release 构建会在被 Git 忽略的 `.papo/` 中生成本机签名；正式发布前必须备份该目录。资料页可检查最新版并打开 APK 下载。架构、权限、调试和发布细节见 [`docs/android.md`](docs/android.md)。

## 校验

```bash
npm test
PAPO_HERMES_DISPATCH=cli RUN_REAL_HERMES_SMOKE=1 npx tsx tests/real-hermes-smoke.ts
```

`npm test` 当前只执行 TypeScript 和生产构建校验。旧 mock UI/验收测试已删除，避免把模板话术当成真实智能验收。
