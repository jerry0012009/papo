# Papo × Hermes 集成规范

## 目标
让 Papo 拥有"手"——通过 Hermes Agent 执行外部任务（搜索、查天气、读网页、操作文件等），每个用户有独立的 Hermes 上下文。

## 架构

```
Papo 服务端
  ├── 用户A → 创建/复用 #papo-user-a 频道 → 发消息给 Hermes Bot
  ├── 用户B → 创建/复用 #papo-user-b 频道 → 发消息给 Hermes Bot
  └── 用户C → 创建/复用 #papo-user-c 频道 → 发消息给 Hermes Bot

Hermes Gateway (单进程，Discord 平台)
  ├── #papo-user-a → 独立会话（有上下文连续性）
  ├── #papo-user-b → 独立会话
  └── #papo-user-c → 独立会话
```

## Papo 侧需要做的事

### 1. 新增 action: "use_hermes"

在 `semantic-action.ts` 的 actionSchema 中添加 `"use_hermes"` 枚举值。

LLM 行动选择的 prompt 中加入说明：
```
- use_hermes：当需要 Papo 自身无法完成的外部能力时使用，例如：
  搜索互联网信息、查询天气/新闻、读取网页内容、计算复杂问题、
  查找实时数据。需要提供一个清晰的任务描述（task）。
```

### 2. 新增 actionResult kind: "hermes_task"

当 action="use_hermes" 时，actionResult 结构：
```json
{
  "kind": "hermes_task",
  "title": "搜索明天西华大学的天气",
  "text": "请帮我查询成都市郫都区明天的天气预报，包括温度和降雨概率"
}
```

### 3. Discord 频道管理（Papo 服务端）

```
需要一个 Papo 自己的 Discord Bot（或复用 Hermes 的 Bot token，但建议独立）

数据表：user_hermes_channels
  - user_id (string) — Papo 用户 ID
  - channel_id (string) — Discord 频道 ID
  - created_at (timestamp)

流程：
  1. 用户首次触发 use_hermes → 创建 Discord 频道 "papo-{user_id}"
  2. 将 Hermes Bot 邀请到该频道（或 Bot 自动加入可见频道）
  3. 保存 user_id → channel_id 映射
  4. 后续复用同一频道（保持上下文连续性）
```

### 4. 异步消息收发（核心：不阻塞）

Hermes 处理复杂任务可能需要几分钟甚至半小时。**绝不阻塞等待。**

```typescript
// 发送任务给 Hermes —— fire and forget
async function sendToHermes(userId: string, task: string): Promise<string> {
  const channelId = await getOrCreateChannel(userId);
  const sentMessage = await discordBot.sendMessage(channelId, task);
  return sentMessage.id; // 返回消息 ID，用于后续匹配回复
}
```

### 5. 前端体验

用户触发 use_hermes 后的前端流程：

```
1. Papo LLM 返回 action="use_hermes" + reply="我去问问虾虾，稍等哦~"
2. 前端展示 Papo 的回复，同时显示一个轻量状态提示：
   「🦐 Papo 正在召唤好朋友虾虾帮忙...」
3. 用户可以继续和 Papo 正常聊天，不被阻塞
4. （可能过了几分钟甚至半小时）
5. Hermes 回复到达 → Papo 服务端处理后推送到对话中
6. 前端对话流里自然出现一条新消息，来自 Papo：
   "虾虾帮我查到了：..."
```

前端只需要：
- 收到 `actionResult.kind === "hermes_task"` 时，展示"召唤虾虾"的提示条
- 提示条不需要倒计时/进度条，就是一个安静的标记
- 后续收到服务端推送的 hermes 回复时，作为正常对话消息渲染

### 6. Hermes 回复监听（服务端后台）

```typescript
// Papo 服务端需要一个 Discord Bot 事件监听器
discordBot.on('messageCreate', async (message) => {
  // 只处理 Hermes Bot 在 papo- 用户频道中的回复
  if (message.author.id !== HERMES_BOT_ID) return;
  if (!message.channel.name.startsWith('papo-')) return;
  
  // 从频道名解析 user_id
  const userId = parseUserIdFromChannel(message.channel.name);
  if (!userId) return;
  
  // 将 Hermes 回复作为新的输入，送入 Papo 语义管线
  await handleHermesReply(userId, message.content);
});

async function handleHermesReply(userId: string, hermesReply: string) {
  // 将回复封装为 StreamSegment
  const segment: StreamSegment = {
    kind: "text",
    label: "虾虾的回复",
    content: hermesReply,
    observedAt: new Date().toISOString()
  };
  
  // 走 Papo 的注意力 → 行动 → 回复 管线
  // Papo 的 LLM 会决定如何向用户呈现（总结、简化、直接转述）
  const result = await processUserInput(userId, [segment], "hermes_callback");
  
  // 将 Papo 的回复推送到前端
  await pushToUserFrontend(userId, result.response);
}
```

### 7. 回复整合

Hermes 回复后，Papo 的 LLM 负责"翻译"——把 Hermes 的专业回复变成 Papo 语气的话：

```
系统提示词补充：
"虾虾是 Papo 的好朋友，擅长搜索和查资料。当收到虾虾的回复时，
用 Papo 自己的语气转述给用户，保持温暖简洁。如果虾虾的回复很长，
提炼关键信息。"
```

## Hermes 侧需要做的事

### 1. 创建 Discord 频道模板
- 频道命名：`papo-{user_id}` 或 `papo-{username}`
- 放在一个专用分类（Category）下，如 "Papo 用户助手"

### 2. Hermes Bot 需要的权限
- 读取消息 + 发送消息
- 在 Papo 创建的频道中可见
- 建议：Hermes Bot 有管理频道权限（方便 Papo 自动创建频道时 Bot 自动加入）

### 3. 配置建议
- Hermes Gateway 常驻运行，监听所有可见频道
- 每个频道的 Hermes 会话会自动保持上下文
- 不需要额外配置，Discord 频道天然就是会话边界

## 注意事项

1. **上下文长度**：Hermes 每个会话有 token 上限，长期对话可能触发压缩。
   如果用户和 Hermes 交互很多，定期检查会话健康。

2. **超时处理**：不设硬超时。Hermes 回复了就推，没回复就等着。
   可以加一个软超时（如 30 分钟）：如果超过 30 分钟没回复，
   给用户一条提示"虾虾可能在忙，我再催催它"。

3. **错误处理**：Hermes 可能返回错误或无法完成任务。
   Papo 的语义管线需要处理这种情况（类似 audio unreadable 的 fallback）。

4. **成本**：每次调用 Hermes 会消耗 LLM tokens。
   建议只在 Papo 自身无法完成时才触发 use_hermes。

5. **安全**：用户输入会原样传给 Hermes。
   考虑是否需要过滤/限制用户能给 Hermes 下达的指令类型。

6. **并发**：同一用户可能连续触发多个 hermes 任务。
   用消息 ID 匹配回复，避免串线。
