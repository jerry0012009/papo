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

`PAPO_PROVIDER` 可显式指定 `openrouter`、`mimo` 或 `generic`。没有显式指定时，按 OpenRouter、Mimo、generic OpenAI-compatible 的顺序选择。

模型可按模态配置：

- `OPENROUTER_MODEL`
- `OPENROUTER_VISION_MODEL`
- `OPENROUTER_AUDIO_MODEL`
- `OPENAI_MODEL`
- `OPENAI_VISION_MODEL`
- `OPENAI_AUDIO_TRANSCRIPTION_MODEL`

音频目前支持 OpenRouter/Mimo 的 multimodal chat route，以及 generic provider 的 `/audio/transcriptions` route。后续应优先迁移到质量、价格、延迟都合适的原生音频模型。

## 校验

```bash
npm test
```

`npm test` 当前只执行 TypeScript 和生产构建校验。旧 mock UI/验收测试已删除，避免把模板话术当成真实智能验收。
