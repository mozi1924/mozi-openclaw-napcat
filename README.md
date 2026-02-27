# @openclaw/napcat

NapCat QQ channel plugin for OpenClaw (OneBot v11 over WebSocket).

## 目标

- 可被 OpenClaw 直接识别和安装（对齐官方插件结构）
- 私聊 + 群聊
- 私聊支持 `dmPolicy=pairing|allowlist|open|disabled`
- 群聊支持群白名单 + 群发言者白名单
- 向 Agent 传递 QQ 场景上下文：
  - 私聊：用户 QQ、昵称
  - 群聊：群号、群名
  - 每条消息：发言者 QQ、昵称、角色（owner/admin/member/unknown）
- 支持拒绝回复标记（默认 `NO_REPLY`）

## 安装识别文件

- `package.json` 包含 `openclaw.extensions` 和 `openclaw.channel/install`
- `openclaw.plugin.json`
- `index.ts` 默认导出 OpenClaw 插件对象

## 基本配置示例

在 OpenClaw 配置中：

```json
{
  "channels": {
    "napcat": {
      "enabled": true,
      "wsMode": "reverse",
      "wsHost": "127.0.0.1",
      "wsPort": 3001,
      "wsPath": "/",
      "accessToken": "your_ws_token",
      "ignoreSelfMessage": true,
      "dmPolicy": "pairing",
      "allowFrom": ["12345678"],
      "groupPolicy": "allowlist",
      "groupRequireMention": true,
      "privateSlashCommandsEnabled": true,
      "groupSlashCommandsEnabled": false,
      "groupAllowFrom": ["12345678"],
      "inboundLogEnabled": true,
      "inboundLogDir": "./logs/napcat-inbound",
      "inboundLogMaxLines": 2000,
      "groups": {
        "987654321": {
          "enabled": true,
          "requireMention": true,
          "allowFrom": ["12345678"]
        }
      },
      "noReplyToken": "NO_REPLY"
    }
  }
}
```

NapCat WebUI 推荐：

- `messagePostFormat` 设为 `array`（插件已兼容 `array|string`）
- `reportSelfMessage` 建议关闭，避免回环

WebSocket 鉴权：

- `accessToken` 用于 WS 鉴权。
- `reverse` 模式下，插件会校验：
  - `Authorization: Bearer <token>` 或
  - URL 查询参数 `access_token=<token>`
- `forward` 模式下，插件会自动携带：
  - `Authorization: Bearer <token>`
  - 并兼容追加 `?access_token=<token>`

心跳与上报建议：

- NapCat `heartInterval` 默认 `30000` 可以保持，不需要额外配置。
- 建议关闭 `reportSelfMessage`，避免机器人自己触发自己。
- 若必须开启 `reportSelfMessage`，保持插件 `ignoreSelfMessage=true`（默认就是 true）。
- `enableForcePushEvent` 可开启；插件仅处理 `message` 与 `notice.poke`。

## 白名单与配对

- 手动白名单：
  - 私聊：`channels.napcat.allowFrom`
  - 群发言者：`channels.napcat.groupAllowFrom` 或 `channels.napcat.groups.<groupId>.allowFrom`
  - 群白名单：`channels.napcat.groups`（仅列出的群会被处理）
- 配对模式：
  - `dmPolicy=pairing` 时，未授权用户私聊会收到配对码
  - 管理端批准后会写入 OpenClaw pairing allowlist（与手动 allowlist 同时生效）

## 消息上下文注入

插件会把以下字段写入 inbound context（供 agent 使用）：

- `SenderQQ` / `SenderId` / `SenderName` / `SenderRole`
- 私聊：`PeerQQ` / `PeerNickname`
- 群聊：`GroupId` / `GroupName` / `GroupSubject`

喂给 agent 的正文会包含前缀：

- 群聊（有群名片）：`[GROUP_CARD:<群名片>;GROUP_NAME:<群名>;QQ_ID:<QQ号>;ROLE:<owner|admin|member|unknown>;GROUP_TITLE:<群头衔可选>;MESSAGE_ID:<消息ID可选>]消息内容`
- 群聊（无群名片）：`[NICKNAME:<昵称>;GROUP_NAME:<群名>;QQ_ID:<QQ号>;ROLE:<owner|admin|member|unknown>;GROUP_TITLE:<群头衔可选>;MESSAGE_ID:<消息ID可选>]消息内容`
- 私聊：`[NICKNAME:<对方昵称>;QQ_ID:<QQ号>;MESSAGE_ID:<消息ID可选>]消息内容`

系统 poke 事件会注入为系统消息文本（群聊/私聊均支持）。

群聊默认仅在 `@机器人` 时投递给 agent，可通过 `groupRequireMention=false` 允许全量群消息投递。

斜杠命令（如 `/reset`）：

- 私聊默认启用：`privateSlashCommandsEnabled=true`
- 但仅配对/白名单通过的私聊可用
- 群聊默认禁用：`groupSlashCommandsEnabled=false`
- 需要时可手动开启群聊斜杠命令

## Message 工具目标写法

从其它 channel/webchat 调用 `message` 工具发 QQ 时：

- `channel`：`napcat`
- 文本字段：使用 `text`（不要用 `message`）
- `target` 支持：
  - `qq:<QQ号>`
  - `private:<QQ号>`
  - `group:<群号>`
  - `session:napcat:private:<QQ号>`
  - `session:napcat:group:<群号>`

## 回复控制标签（给 Agent）

Agent 回复文本可携带以下标签，插件会执行后再发送文本：

- 静默：`[SILENT]` 或 `[NO_REPLY]`
- 回复某条消息：`[REPLY:<message_id>]`
- @某人：`[AT:<qq>]`
- @全体：`[AT_ALL]`（插件会先查剩余次数，若不可用则跳过）
- 戳一戳：`[POKE]`（当前会话对象）或 `[POKE:<qq>]`
- 群管理：
  - 踢人：`[KICK:<qq>]`
  - 禁言：`[MUTE:<qq>:<seconds>]`（执行后会查询禁言列表进行确认调用）

说明：

- 标签可以组合。
- 如果只想执行动作不发文字，添加 `[SILENT]`。
- 群管理动作是否成功取决于机器人在群内权限。

## 入站日志

- 开关：`inboundLogEnabled`（默认 `true`）
- 目录：`inboundLogDir`（默认 `./logs/napcat-inbound`）
- 单文件最大行数：`inboundLogMaxLines`（默认 `2000`）
- 文件命名：
  - 私聊：`qq-<qq>.log`
  - 群聊：`group-<groupId>.log`
- 超过最大行数会自动截断，仅保留最新记录，避免长期占用大量磁盘空间。

## Skills（已修正目录名）

- 技能目录使用 `skills/napcat-qq`（不是 `skill`）。
- 文件：
  - `/skills/napcat-qq/SKILL.md`
  - `/skills/napcat-qq/agents/openai.yaml`

## 拒绝回复

- 当模型输出内容去空白后等于 `noReplyToken`（默认 `NO_REPLY`），插件不发送任何回复。
