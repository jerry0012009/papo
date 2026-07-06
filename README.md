# Papo AI 小动物 Demo

Papo 是一个 mobile-first Demo，用最小可行方式展示一个有注意、动力、情景记忆、反馈强化和行动选择的 AI companion。

当前版本包含 Creature Brain v0.2：Curious Session 审计、可解释 action selection、反馈策略学习、记忆巩固候选，以及三类主动浮现机制。

Goal 3 adds a lighter Demo Mode and creature-facing experience language. Default demo inputs use everyday life context, not Papo development notes.

Curious Mode also includes an experimental voice companionship control: in supported browsers it listens for up to 3 minutes and turns speech recognition output into 30-second `audio_transcript` segments. Raw audio is not stored.

## 生命体 Agent Harness

Demo 采用混合 harness，而不是纯聊天或纯规则：

1. Sense：把 button 或 curious stream 输入转成 observation。
2. Attend：规则层先生成候选 attention event，保证可解释和可测试。
3. Interpret：有 Mimo/OpenRouter/通用 API 时，LLM 语义脑会改进“它注意到了什么、为什么、用户可能在做什么、适合怎样回应”。
4. Guardrail：规则层检查隐私、精力、状态范围和行动合法性。
5. Remember：写入情景记忆，可在反馈后升成长记忆。
6. Learn：反馈改变状态和记忆权重。
7. Emerge：主动浮现从已有记忆和内部状态触发。

规则负责生命体的骨架和边界：

- 小动物状态初始化和状态范围约束
- Button Capture 的基础 attention event
- Curious Mode 的基础显著性打分
- 行动选择护栏
- 情景记忆与长期记忆写入
- 用户反馈对状态和记忆权重的影响
- 多用户数据隔离
- 主动浮现的记忆选择

这些部分必须可解释、可测试、可调参。

LLM 负责语义质量：

- 更准确地解释“为什么注意到”
- 判断用户可能意图
- 形成更自然的情景记忆文案
- 给出行动建议，再由规则护栏确认
- 未来接图片、音频和更复杂上下文理解

没有 API key 时，fallback provider 仍可跑完整闭环。

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

Provider 选择优先级：

1. `OPENROUTER_API_KEY`
2. `MIMO_ENDPOINT` / `MIMO_API_KEY`
3. `OPENAI_API_KEY` / `GENERIC_MODEL_API_KEY`
4. fallback demo brain

## 测试

```bash
npm test
```

测试保护核心闭环：多用户隔离、注意事件、情景记忆、反馈强化、长期记忆、主动浮现和主要 API。

## 3 分钟演示脚本

1. 打开首页，选择或创建一个小动物，看状态和当前心情。
2. 在 Button Capture 输入一段创业想法，观察 attention event 和情景记忆卡。
3. 点“记住”和“理解对了”，看状态变化与长期记忆。
4. 打开 Curious Mode，输入多段信息流，让它主动挑出 1-3 个重点。
5. 点“它现在在想什么”，看它基于旧记忆主动浮现。
