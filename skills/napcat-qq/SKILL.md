---
name: napcat-qq
description: "通过 OpenClaw 的 napcat channel 发送 QQ 私聊/群聊消息，支持静默、@、回复、poke 与群管理标签。"
---

# 目标

在需要向 QQ 发送消息时，优先使用 `message` 工具并显式指定 `channel: "napcat"`，避免跨通道路由错误。

# 目标格式

- 私聊：`qq:<QQ号>` 或 `private:<QQ号>`
- 群聊：`group:<群号>`
- 会话键：`session:napcat:private:<QQ号>` / `session:napcat:group:<群号>`

# 调用规则

1. 调用 `message` 工具时，必须显式设置 `channel=napcat`。
2. 用户给的是纯数字时，默认按私聊处理；若语义是群消息，改写为 `group:<群号>`。
3. 发送媒体时使用 `mediaUrl`，可同时带 `text`。
4. 未提供目标 ID 时先询问，不做猜测发送。
5. 回复风格默认口语化、简洁，避免冗长输出。

# 回复控制标签

可在回复文本中使用以下标签：

- 静默：`[SILENT]`
- 回复某条消息：`[REPLY:<message_id>]`
- @某人：`[AT:<qq>]`
- @全体：`[AT_ALL]`
- 戳一戳：`[POKE]`（当前会话对象）或 `[POKE:<qq>]`
- 群管理：
  - 踢人：`[KICK:<qq>]`
  - 禁言：`[MUTE:<qq>:<seconds>]`

说明：

- 标签可组合，插件会先执行动作，再发送剩余文本。
- 只想执行动作不发文字时，附加 `[SILENT]`。
- 群管理动作需要机器人具备对应权限，否则会失败并在日志体现。

# 查询建议

- 需要确认群名、用户昵称时，先使用 napcat channel 的目录/解析能力查询，再发送。
- 对群场景，优先按群号发送，避免同名群歧义。
- 需要保持安静（只动作不发言）时，优先使用 `[SILENT]`。
