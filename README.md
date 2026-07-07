# Papo AI 小动物 Demo

Papo 是一个 mobile-first Demo，用最小可行方式展示一只住在手机里的 AI 小动物：它会注意、会记住、会被反馈养成，也会在之后自己想起一件旧事。

当前版本包含 Creature Brain v0.2：可解释注意选择、反馈策略学习、情景记忆巩固候选，以及三类主动浮现机制。

Goal 3 adds a lighter guided demo and creature-facing experience language. Default demo inputs use everyday life context, not Papo development notes.

“陪我一会儿” includes an experimental voice companionship control: in supported browsers it listens for up to 3 minutes and turns speech into editable 30-second life fragments. Raw audio is not stored.
Server-side audio sensing uses provider-specific routes: OpenRouter/Mimo may use multimodal chat when the account supports audio input, while generic OpenAI-compatible providers use `/audio/transcriptions` with a transcription model.

## 生命体 Agent Harness

Demo 采用混合 harness，而不是纯聊天或纯规则：

1. Sense：把对话、照片、录音或 30 秒共同片段转成 observation。
2. Attend：规则层先生成候选 attention event，保证边界、预算和可审计。
3. Interpret：真实 LLM 语义脑理解“发生了什么、Papo 要不要回应、怎么回应、要不要记住”。
4. Guardrail：规则层检查隐私、精力、状态范围和行动合法性。
5. Remember：写入情景记忆，可在反馈后升成长记忆。
6. Learn：反馈改变状态和记忆权重。
7. Emerge：主动浮现从已有记忆和内部状态触发。

规则负责生命体的骨架和边界：

- 小动物状态初始化和状态范围约束
- 直接对话和多模态输入的候选事件
- 多段生活片段的候选显著性打分
- 行动选择护栏
- 情景记忆与长期记忆写入
- 用户反馈对状态和记忆权重的影响
- 多用户数据隔离
- 主动浮现的记忆选择

这些部分必须可解释、可测试、可调参。

LLM 负责语义质量：

- 理解文字、照片和音频里的真实语义
- 判断用户意图、情绪和当前事件
- 决定是否回应、询问、安静、记住或回忆
- 写出 Papo 最终对用户说的话
- 形成可保存的小回忆和记忆标签

没有真实模型配置时，Papo 不会伪造理解；相关接口会直接报错，方便排查通路。

## 运行

```bash
npm install
npm run dev
```

默认地址：

- Web: http://localhost:5173
- API: http://localhost:8787

公网 Demo:

- Web: https://eu.jerrypsy.top/papo/
- API health: https://eu.jerrypsy.top/papo-api/health

生产子路由构建：

```bash
VITE_BASE_PATH=/papo/ VITE_API_BASE=/papo-api npm run build
npm run serve:api
```

Provider 配置来源：

- 环境变量
- `papo.config.json`
- `.papo/provider.json`

环境变量会覆盖本地配置文件。可从 `papo.config.example.json` 复制配置结构。
`PAPO_PROVIDER` 可显式指定 `openrouter`、`mimo` 或 `generic`；未指定时按下面顺序自动选择。
`PAPO_AUDIO_PROVIDER=generic` can route only audio sensing through the generic transcription endpoint while keeping OpenRouter or Mimo as the semantic brain. Set `PAPO_AUDIO_PROVIDER=primary` to force audio through the primary provider.
Generic/OpenAI-compatible audio transcription should use `OPENAI_AUDIO_TRANSCRIPTION_MODEL` or `OPENAI_TRANSCRIPTION_MODEL`; if unset, Papo defaults to `gpt-4o-mini-transcribe`.

Provider 选择优先级：

1. `OPENROUTER_API_KEY`
2. `MIMO_ENDPOINT` / `MIMO_API_KEY`
3. `OPENAI_API_KEY` / `GENERIC_MODEL_API_KEY`

## 测试

```bash
npm test
npm run test:e2e
```

测试保护核心闭环：多用户隔离、注意事件、情景记忆、反馈强化、长期记忆、主动浮现和主要 API。
`npm run test:e2e` uses Playwright Chromium to check the mobile/desktop lifeform surfaces in a real browser.

## 3 分钟演示脚本

1. 打开首页，选择或创建一只 Papo，看它现在的身体信号和正在抱着的状态。
2. 进入“对话”，用文字、照片或录音递给它一件刚发生的小事，看它是否选择回应、记下或追问。
3. 对它的理解点“帮我记住”“再想一会儿”或“先安静点”，看它马上说出自己学到了什么。
4. 打开“陪我”，给它 8 段生活片段或听 3 分钟，让它只认真盯住 1-3 个重点。
5. 打开“演示”，带它完整走一圈，看“它会注意、会被养成、会主动想起”的最小生命闭环。
