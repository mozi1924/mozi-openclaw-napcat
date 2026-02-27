import {
  applyAccountNameToChannelSection,
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
  type RuntimeEnv
} from "openclaw/plugin-sdk";
import {
  isAllowedByAllowlist,
  listNapcatAccountIds,
  normalizeAllowlist,
  resolveDefaultNapcatAccountId,
  resolveNapcatAccount,
  type ResolvedNapcatAccount
} from "./config.js";
import { NapcatGateway } from "./napcat-channel.js";
import { appendInboundLog, resolveInboundLogPath } from "./logging.js";
import { getNapcatRuntime } from "./runtime.js";
import type { CoreConfig, NapcatInboundMessage } from "./types.js";

const CHANNEL_ID = "napcat" as const;
const activeGateways = new Map<string, NapcatGateway>();

function getActiveGateway(accountId?: string): NapcatGateway | null {
  return activeGateways.get(accountId ?? DEFAULT_ACCOUNT_ID) ?? null;
}

function parseOutboundTarget(input: string): { kind: "private" | "group"; id: number } | null {
  const raw = input.trim();
  const s = raw.match(/^session:napcat:(private|group):(\d+)$/i);
  if (s) {
    return { kind: s[1].toLowerCase() as "private" | "group", id: Number(s[2]) };
  }
  const m = raw.match(/^(qq|private|group):(\d+)$/i);
  if (m) {
    const kind = m[1].toLowerCase() === "group" ? "group" : "private";
    return { kind, id: Number(m[2]) };
  }
  if (/^\d+$/.test(raw)) {
    return { kind: "private", id: Number(raw) };
  }
  return null;
}

function sanitizeContextValue(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) {
    return "";
  }
  return v.replaceAll(";", "，").replaceAll("]", "）");
}

function stripControlTag(text: string, tag: string): { hit: boolean; text: string } {
  const rx = new RegExp(`\\[${tag}\\]`, "gi");
  if (!rx.test(text)) {
    return { hit: false, text };
  }
  return { hit: true, text: text.replace(rx, "").trim() };
}

function pullAllMatches(text: string, re: RegExp): { values: string[]; text: string } {
  const values: string[] = [];
  let next = text;
  for (;;) {
    const m = re.exec(next);
    if (!m) {
      break;
    }
    values.push(m[1] ?? "");
    next = `${next.slice(0, m.index)}${next.slice(m.index + m[0].length)}`.trim();
    re.lastIndex = 0;
  }
  return { values, text: next };
}

type ReplyControl = {
  silent: boolean;
  replyToIds: string[];
  atQqs: string[];
  atAll: boolean;
  pokeSelfTarget: boolean;
  pokeUsers: string[];
  kickUsers: string[];
  muteUsers: Array<{ qq: string; duration: number }>;
  body: string;
};

function parseReplyControl(raw: string): ReplyControl {
  let text = raw.trim();
  const silentTag = stripControlTag(text, "SILENT");
  text = silentTag.text;
  const noReplyTag = stripControlTag(text, "NO_REPLY");
  text = noReplyTag.text;
  const atAllTag = stripControlTag(text, "AT_ALL");
  text = atAllTag.text;
  const pokeTag = stripControlTag(text, "POKE");
  text = pokeTag.text;

  const replyParsed = pullAllMatches(text, /\[REPLY:([0-9A-Za-z:_-]+)\]/i);
  text = replyParsed.text;
  const atParsed = pullAllMatches(text, /\[AT:(\d+)\]/i);
  text = atParsed.text;
  const pokeParsed = pullAllMatches(text, /\[POKE:(\d+)\]/i);
  text = pokeParsed.text;
  const kickParsed = pullAllMatches(text, /\[KICK:(\d+)\]/i);
  text = kickParsed.text;

  const muteUsers: Array<{ qq: string; duration: number }> = [];
  for (;;) {
    const m = /\[MUTE:(\d+):(\d+)\]/i.exec(text);
    if (!m) {
      break;
    }
    muteUsers.push({ qq: m[1], duration: Number(m[2]) });
    text = `${text.slice(0, m.index)}${text.slice(m.index + m[0].length)}`.trim();
  }

  return {
    silent: silentTag.hit || noReplyTag.hit,
    replyToIds: replyParsed.values,
    atQqs: atParsed.values,
    atAll: atAllTag.hit,
    pokeSelfTarget: pokeTag.hit,
    pokeUsers: pokeParsed.values,
    kickUsers: kickParsed.values,
    muteUsers,
    body: text
  };
}

function buildBodyForAgent(message: NapcatInboundMessage): string {
  const raw = message.text.trim();
  if (raw.startsWith("/")) {
    return raw;
  }
  if (raw === "__SYSTEM_POKE__") {
    if (message.chatType === "group") {
      const groupName = sanitizeContextValue(message.groupName) || String(message.groupId ?? "");
      const messageId = message.messageId ? `;MESSAGE_ID:${message.messageId}` : "";
      return `[SYSTEM_MESSAGE:POKE;GROUP_NAME:${groupName};QQ_ID:${message.userQq}${messageId}]有人戳了你`;
    }
    const messageId = message.messageId ? `;MESSAGE_ID:${message.messageId}` : "";
    return `[SYSTEM_MESSAGE:POKE;QQ_ID:${message.userQq}${messageId}]有人戳了你`;
  }
  if (message.chatType === "group") {
    const groupCard = sanitizeContextValue(message.userCard);
    const nickname = sanitizeContextValue(message.userNickname);
    const groupName = sanitizeContextValue(message.groupName) || String(message.groupId ?? "");
    const qqId = String(message.userQq);
    const role = message.userRole;
    const prefixName = groupCard
      ? `GROUP_CARD:${groupCard}`
      : `NICKNAME:${nickname}`;
    const title = sanitizeContextValue(message.userTitle);
    const titlePart = title ? `;GROUP_TITLE:${title}` : "";
    const messageId = message.messageId ? `;MESSAGE_ID:${message.messageId}` : "";
    return `[${prefixName};GROUP_NAME:${groupName};QQ_ID:${qqId};ROLE:${role}${titlePart}${messageId}]${raw}`;
  }
  const nickname = sanitizeContextValue(message.userNickname);
  const messageId = message.messageId ? `;MESSAGE_ID:${message.messageId}` : "";
  return `[NICKNAME:${nickname};QQ_ID:${message.userQq}${messageId}]${raw}`;
}

function isMentioned(text: string, selfQq?: number, wasAtSelf?: boolean): boolean {
  if (wasAtSelf) {
    return true;
  }
  if (!selfQq) {
    return false;
  }
  return text.includes(`[CQ:at,qq=${selfQq}]`) || text.includes(`@${selfQq}`);
}

async function deliverNapcatReply(params: {
  gateway?: NapcatGateway;
  account: ResolvedNapcatAccount;
  message: NapcatInboundMessage;
  text: string;
}): Promise<void> {
  const raw = params.text.trim();
  if (!raw || raw === params.account.noReplyToken) {
    return;
  }
  const gateway = activeGateways.get(params.account.accountId) ?? params.gateway;
  if (!gateway) {
    throw new Error("napcat websocket not connected");
  }

  const ctrl = parseReplyControl(raw);
  const cqParts: string[] = [];
  if (ctrl.replyToIds.length > 0) {
    cqParts.push(`[CQ:reply,id=${ctrl.replyToIds[0]}]`);
  }
  for (const qq of ctrl.atQqs) {
    cqParts.push(`[CQ:at,qq=${qq}]`);
  }

  if (params.message.chatType === "group" && params.message.groupId) {
    if (ctrl.atAll) {
      try {
        const remain = await gateway.getGroupAtAllRemain(params.message.groupId);
        const canAtAll =
          remain.can_at_all !== false &&
          (typeof remain.remain_at_all_count_for_group !== "number" ||
            remain.remain_at_all_count_for_group > 0);
        if (canAtAll) {
          cqParts.push("[CQ:at,qq=all]");
        }
      } catch {
        // ignore
      }
    }
    for (const qq of ctrl.kickUsers) {
      try {
        await gateway.setGroupKick(params.message.groupId, Number(qq));
      } catch {
        // ignore permission errors to avoid breaking whole reply
      }
    }
    for (const m of ctrl.muteUsers) {
      try {
        await gateway.setGroupBan(params.message.groupId, Number(m.qq), m.duration);
        await gateway.getGroupShutList(params.message.groupId);
      } catch {
        // ignore permission errors
      }
    }
    if (ctrl.pokeSelfTarget) {
      try {
        await gateway.groupPoke(params.message.groupId, params.message.userQq);
      } catch {
        // ignore
      }
    }
    for (const qq of ctrl.pokeUsers) {
      try {
        await gateway.groupPoke(params.message.groupId, Number(qq));
      } catch {
        // ignore
      }
    }
  } else {
    if (ctrl.pokeSelfTarget) {
      try {
        await gateway.friendPoke(params.message.userQq);
      } catch {
        // ignore
      }
    }
    for (const qq of ctrl.pokeUsers) {
      try {
        await gateway.friendPoke(Number(qq));
      } catch {
        // ignore
      }
    }
  }

  if (ctrl.silent) {
    return;
  }

  const text = [cqParts.join(""), ctrl.body].filter(Boolean).join("").trim();
  if (!text) {
    return;
  }

  if (params.message.chatType === "private") {
    await gateway.sendPrivateMessage(params.message.userQq, text);
    try {
      await gateway.setInputStatus(params.message.userQq, 0);
    } catch {
      // ignore
    }
    return;
  }
  if (!params.message.groupId) {
    return;
  }
  await gateway.sendGroupMessage(params.message.groupId, text);
}

async function handleNapcatInbound(params: {
  message: NapcatInboundMessage;
  account: ResolvedNapcatAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  gateway: NapcatGateway;
}): Promise<void> {
  const { message, account, config, runtime, gateway } = params;
  const core = getNapcatRuntime();
  const rawBody = message.text.trim();
  if (!rawBody) {
    return;
  }
  const bodyForAgent = buildBodyForAgent(message);
  const isSlashCommand = rawBody.startsWith("/");
  if (account.inboundLogEnabled) {
    try {
      const filePath = resolveInboundLogPath({
        dir: account.inboundLogDir,
        chatType: message.chatType,
        userQq: message.userQq,
        groupId: message.groupId
      });
      await appendInboundLog({
        filePath,
        maxLines: account.inboundLogMaxLines,
        payload: {
          ts: new Date(message.timestamp).toISOString(),
          message_type: message.chatType,
          group_id: message.groupId,
          user_id: message.userQq,
          message_id: message.messageId,
          raw_message: message.text,
          sender: {
            nickname: message.userNickname,
            card: message.userCard,
            role: message.userRole,
            title: message.userTitle
          }
        }
      });
    } catch (err) {
      runtime.error?.(`napcat: append inbound log failed: ${String(err)}`);
    }
  }

  const isGroup = message.chatType === "group";
  const senderId = String(message.userQq);
  const senderName = message.userNickname;

  const configAllowFrom = normalizeAllowlist(account.allowFrom);
  const storeAllowFrom =
    account.dmPolicy === "allowlist"
      ? []
      : await core.channel.pairing.readAllowFromStore(CHANNEL_ID).catch(() => []);
  const storeAllowList = normalizeAllowlist(storeAllowFrom);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowList];

  if (!isGroup) {
    if (account.dmPolicy === "disabled") {
      runtime.log?.(`napcat: drop dm sender=${senderId} (dmPolicy=disabled)`);
      return;
    }
    if (account.dmPolicy !== "open" && !isAllowedByAllowlist(effectiveAllowFrom, message.userQq)) {
      if (account.dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: CHANNEL_ID,
          id: senderId,
          meta: { name: senderName || undefined }
        });
        if (created) {
          await gateway.sendPrivateMessage(
            message.userQq,
            core.channel.pairing.buildPairingReply({
              channel: CHANNEL_ID,
              idLine: `Your QQ id: ${senderId}`,
              code
            })
          );
        }
      }
      runtime.log?.(`napcat: drop dm sender=${senderId} (dmPolicy=${account.dmPolicy}, not allowlisted)`);
      return;
    }
    if (isSlashCommand) {
      const pairedAllowed = isAllowedByAllowlist(effectiveAllowFrom, message.userQq);
      if (!account.privateSlashCommandsEnabled || !pairedAllowed) {
        runtime.log?.(
          `napcat: drop dm slash command sender=${senderId} (privateSlashCommandsEnabled=${account.privateSlashCommandsEnabled}, paired=${pairedAllowed})`
        );
        return;
      }
    }
  } else {
    if (!message.groupId) {
      runtime.log?.("napcat: drop group message (missing groupId)");
      return;
    }
    if (account.groupPolicy === "disabled") {
      runtime.log?.(`napcat: drop group=${message.groupId} (groupPolicy=disabled)`);
      return;
    }
    const groups = account.groups ?? {};
    const exactGroupCfg = groups[String(message.groupId)];
    const wildcardGroupCfg = groups["*"];
    const groupCfg = exactGroupCfg ?? wildcardGroupCfg;

    const hasGroupWhitelist = Object.keys(groups).length > 0;
    const inGroupWhitelist = Boolean(exactGroupCfg || wildcardGroupCfg);
    if (hasGroupWhitelist && !inGroupWhitelist) {
      runtime.log?.(`napcat: drop group=${message.groupId} (group not in channels.napcat.groups whitelist)`);
      return;
    }
    if (groupCfg?.enabled === false) {
      runtime.log?.(`napcat: drop group=${message.groupId} (group config disabled)`);
      return;
    }

    const requireMention = groupCfg?.requireMention ?? account.groupRequireMention;
    if (requireMention && !isMentioned(rawBody, message.selfQq, message.wasAtSelf)) {
      runtime.log?.(`napcat: drop group=${message.groupId} sender=${senderId} (requireMention=true and not mentioned)`);
      return;
    }

    if (account.groupPolicy === "allowlist") {
      const outerAllow = normalizeAllowlist(account.groupAllowFrom);
      const innerAllow = normalizeAllowlist(groupCfg?.allowFrom);
      const allowList = innerAllow.length > 0 ? innerAllow : outerAllow;
      if (allowList.length > 0 && !isAllowedByAllowlist(allowList, message.userQq)) {
        runtime.log?.(
          `napcat: drop group=${message.groupId} sender=${senderId} (group sender allowlist mismatch, allow=${allowList.join(",")})`
        );
        return;
      }
    }
    if (isSlashCommand && !account.groupSlashCommandsEnabled) {
      runtime.log?.(`napcat: drop group slash command group=${message.groupId} (groupSlashCommandsEnabled=false)`);
      return;
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? String(message.groupId) : senderId
    }
  });

  const conversationDisplayName = isGroup
    ? message.groupName || `group:${message.groupId}`
    : senderName || `qq:${senderId}`;
  const fromLabel = conversationDisplayName;

  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    {
      agentId: route.agentId
    }
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "NapCat",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `napcat:group:${message.groupId}` : `napcat:${senderId}`,
    To: isGroup ? `napcat:group:${message.groupId}` : `napcat:${senderId}`,
    SessionKey: route.sessionKey,
    SessionDisplayName: conversationDisplayName,
    displayName: conversationDisplayName,
    name: conversationDisplayName,
    Title: conversationDisplayName,
    ConversationTitle: conversationDisplayName,
    Topic: conversationDisplayName,
    Subject: conversationDisplayName,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationDisplayName,
    SenderName: senderName || undefined,
    SenderId: senderId,
    SenderQQ: senderId,
    SenderRole: message.userRole,
    PeerQQ: isGroup ? undefined : senderId,
    PeerNickname: isGroup ? undefined : senderName || undefined,
    GroupId: isGroup ? String(message.groupId) : undefined,
    GroupSubject: isGroup ? message.groupName || String(message.groupId) : undefined,
    GroupName: isGroup ? message.groupName || String(message.groupId) : undefined,
    WasMentioned: isGroup ? isMentioned(rawBody, message.selfQq, message.wasAtSelf) : undefined,
    CommandAuthorized: true,
    MessageSid: message.messageId ? String(message.messageId) : `napcat:${message.timestamp}:${senderId}`,
    Timestamp: message.timestamp,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: isGroup ? `napcat:group:${message.groupId}` : `napcat:${senderId}`
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => runtime.error?.(`napcat: failed updating session meta: ${String(err)}`)
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId
  });
  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    await deliverNapcatReply({
      gateway,
      account,
      message,
      text: payload.text || ""
    });
  });

  if (!isGroup) {
    try {
      await gateway.setInputStatus(message.userQq, 1);
    } catch (err) {
      runtime.error?.(`napcat: set_input_status typing failed: ${String(err)}`);
    }
  }
  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config as OpenClawConfig,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: deliverReply,
        onError: (err, info) => {
          runtime.error?.(`napcat ${info.kind} reply failed: ${String(err)}`);
        }
      },
      replyOptions: {
        onModelSelected
      }
    });
  } finally {
    if (!isGroup) {
      try {
        await gateway.setInputStatus(message.userQq, 0);
      } catch (err) {
        runtime.error?.(`napcat: set_input_status idle failed: ${String(err)}`);
      }
    }
  }
}

export const napcatPlugin: ChannelPlugin<ResolvedNapcatAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "NapCat",
    selectionLabel: "NapCat (QQ)",
    docsPath: "/channels/napcat",
    docsLabel: "napcat",
    blurb: "QQ channel plugin via NapCat OneBot WebSocket.",
    aliases: ["qq", "onebot", "nap"],
    order: 75,
    quickstartAllowFrom: true
  },
  pairing: {
    idLabel: "qq",
    normalizeAllowEntry: (entry) => entry.replace(/^(qq|napcat):/i, ""),
    notifyApproval: async ({ id }) => {
      const gateway = activeGateways.get(DEFAULT_ACCOUNT_ID);
      if (!gateway) {
        return;
      }
      await gateway.sendPrivateMessage(Number(id), "配对已通过，你现在可以私聊我了。");
    }
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: true
  },
  reload: { configPrefixes: ["channels.napcat"] },
  configSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      groupRequireMention: {
        type: "boolean",
        title: "Group Require Mention",
        description: "Default true. If false, all group messages can be delivered to agent."
      },
      privateSlashCommandsEnabled: {
        type: "boolean",
        title: "Private Slash Commands Enabled",
        description: "Default true. Allow /commands in private chats (paired users only)."
      },
      groupSlashCommandsEnabled: {
        type: "boolean",
        title: "Group Slash Commands Enabled",
        description: "Default false. Allow /commands in group chats."
      },
      inboundLogEnabled: {
        type: "boolean",
        title: "Inbound Log Enabled",
        description: "Store inbound message logs to local JSONL files."
      },
      inboundLogDir: {
        type: "string",
        title: "Inbound Log Directory",
        description: "Directory for inbound logs."
      },
      inboundLogMaxLines: {
        type: "number",
        title: "Inbound Log Max Lines",
        description: "Max lines kept per log file."
      }
    }
  },
  config: {
    listAccountIds: (cfg) => listNapcatAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveNapcatAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNapcatAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "napcat",
        accountId,
        enabled,
        allowTopLevel: true
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "napcat",
        accountId,
        clearBaseFields: ["accessToken", "wsUrl", "wsHost", "wsPort", "wsPath", "name"]
      }),
    isConfigured: (account) =>
      account.wsMode === "reverse" || (account.wsMode === "forward" && Boolean(account.wsUrl?.trim())),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured:
        account.wsMode === "reverse" || (account.wsMode === "forward" && Boolean(account.wsUrl?.trim())),
      wsMode: account.wsMode
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveNapcatAccount({ cfg: cfg as CoreConfig, accountId }).allowFrom ?? []).map((entry) =>
        String(entry)
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(qq|napcat):/i, ""))
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.napcat?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.napcat.accounts.${resolvedAccountId}.`
        : "channels.napcat.";
      return {
        policy: account.dmPolicy ?? "pairing",
        allowFrom: account.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint(CHANNEL_ID),
        normalizeEntry: (raw) => raw.replace(/^(qq|napcat):/i, "")
      };
    }
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveNapcatAccount({ cfg: cfg as CoreConfig, accountId });
      if (!groupId) {
        return account.groupRequireMention;
      }
      const groupCfg = account.groups[String(groupId)] ?? account.groups["*"];
      return groupCfg?.requireMention ?? account.groupRequireMention;
    },
    resolveToolPolicy: () => null
  },
  messaging: {
    normalizeTarget: (target) => String(target).trim(),
    targetResolver: {
      looksLikeId: (target) => Boolean(parseOutboundTarget(String(target))),
      hint: "<qq|qq:ID|private:ID|group:ID|session:napcat:private:ID|session:napcat:group:ID>"
    }
  },
  agentPrompt: {
    messageToolHints: () => [
      "- NapCat targets: `qq:123456`, `private:123456`, `group:987654321`.",
      "- Session targets also supported: `session:napcat:private:123456`, `session:napcat:group:987654321`.",
      "- To send from any channel via message tool, set `channel` to `napcat` and provide one of the targets above.",
      "- For live name lookup, use directory/resolver in this channel to resolve QQ/group IDs before sending.",
      "- Reply controls in text: `[SILENT]`, `[REPLY:<message_id>]`, `[AT:<qq>]`, `[AT_ALL]`, `[POKE]`, `[POKE:<qq>]`, `[KICK:<qq>]`, `[MUTE:<qq>:<seconds>]`.",
      "- Keep replies conversational and concise by default."
    ]
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
    listPeersLive: async ({ accountId }) => {
      const gateway = getActiveGateway(accountId);
      if (!gateway) {
        return [];
      }
      const peers = await gateway.getFriendList();
      const out: Array<{ id: string; name: string }> = [];
      for (const entry of peers) {
        const id = entry.user_id ? String(entry.user_id) : "";
        if (!id) {
          continue;
        }
        const name = (entry.remark || entry.nickname || id).trim();
        out.push({ id, name });
      }
      return out;
    },
    listGroupsLive: async ({ accountId }) => {
      const gateway = getActiveGateway(accountId);
      if (!gateway) {
        return [];
      }
      const groups = await gateway.getGroupList();
      const out: Array<{ id: string; name: string }> = [];
      for (const entry of groups) {
        const id = entry.group_id ? String(entry.group_id) : "";
        if (!id) {
          continue;
        }
        const name = (entry.group_name || id).trim();
        out.push({ id, name });
      }
      return out;
    }
  },
  resolver: {
    resolveTargets: async ({ accountId, inputs, kind }) => {
      const gateway = getActiveGateway(accountId);
      if (!gateway) {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "napcat gateway not connected"
        }));
      }
      if (kind === "group") {
        const groups = await gateway.getGroupList();
        const byId = new Map(groups.map((g) => [String(g.group_id ?? ""), g.group_name || ""]));
        return inputs.map((input) => {
          const text = String(input).trim();
          const parsed = parseOutboundTarget(text);
          if (parsed?.kind === "group") {
            return {
              input,
              resolved: true,
              id: String(parsed.id),
              name: byId.get(String(parsed.id)) || undefined
            };
          }
          if (/^\d+$/.test(text)) {
            return {
              input,
              resolved: true,
              id: text,
              name: byId.get(text) || undefined
            };
          }
          const matched = groups.find((g) => (g.group_name || "").trim() === text);
          if (matched?.group_id) {
            return {
              input,
              resolved: true,
              id: String(matched.group_id),
              name: matched.group_name || undefined
            };
          }
          return { input, resolved: false, note: "group not found" };
        });
      }

      const friends = await gateway.getFriendList();
      const byId = new Map(
        friends.map((f) => [String(f.user_id ?? ""), (f.remark || f.nickname || "").trim()])
      );
      return inputs.map((input) => {
        const text = String(input).trim();
        const parsed = parseOutboundTarget(text);
        if (parsed?.kind === "private") {
          return {
            input,
            resolved: true,
            id: String(parsed.id),
            name: byId.get(String(parsed.id)) || undefined
          };
        }
        if (/^\d+$/.test(text)) {
          return { input, resolved: true, id: text, name: byId.get(text) || undefined };
        }
        const matched = friends.find((f) => {
          const n = (f.nickname || "").trim();
          const r = (f.remark || "").trim();
          return n === text || r === text;
        });
        if (matched?.user_id) {
          return {
            input,
            resolved: true,
            id: String(matched.user_id),
            name: (matched.remark || matched.nickname || "").trim() || undefined
          };
        }
        return { input, resolved: false, note: "user not found" };
      });
    }
  },
  setup: {
    resolveAccountId: ({ accountId }) => (accountId?.trim() ? accountId.trim() : DEFAULT_ACCOUNT_ID),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "napcat",
        accountId,
        name
      }),
    validateInput: () => null,
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const name = typeof input.name === "string" ? input.name : undefined;
      const next = applyAccountNameToChannelSection({
        cfg,
        channelKey: "napcat",
        accountId,
        name
      });
      return {
        ...next,
        channels: {
          ...next.channels,
          napcat: {
            ...next.channels?.napcat,
            enabled: true
          }
        }
      } as OpenClawConfig;
    }
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 2000,
    sendText: async ({ to, text, accountId }) => {
      const target = parseOutboundTarget(String(to));
      if (!target) {
        throw new Error(`Invalid NapCat target: ${String(to)}`);
      }
      const gateway = activeGateways.get(accountId ?? DEFAULT_ACCOUNT_ID);
      if (!gateway) {
        throw new Error("NapCat gateway not started");
      }
      if (target.kind === "group") {
        await gateway.sendGroupMessage(target.id, text);
      } else {
        await gateway.sendPrivateMessage(target.id, text);
      }
      return {
        channel: CHANNEL_ID,
        target: String(to),
        messageId: `napcat:${Date.now()}`
      };
    }
  },
  gateway: {
    startAccount: async (ctx) => {
      const existing = activeGateways.get(ctx.accountId);
      if (existing) {
        await existing.stop();
        activeGateways.delete(ctx.accountId);
      }

      const account = ctx.account;
      ctx.log?.info(
        `[${ctx.accountId}] NapCat config wsMode=${account.wsMode} host=${account.wsHost} port=${account.wsPort} path=${account.wsPath} wsUrl=${account.wsUrl ?? "-"}`
      );
      const gateway = new NapcatGateway({
        wsMode: account.wsMode,
        wsHost: account.wsHost,
        wsPort: account.wsPort,
        wsPath: account.wsPath,
        wsUrl: account.wsUrl,
        accessToken: account.accessToken,
        ignoreSelfMessage: account.ignoreSelfMessage,
        onMessage: async (message) => {
          await handleNapcatInbound({
            message,
            account,
            config: ctx.cfg as CoreConfig,
            runtime: ctx.runtime,
            gateway
          });
        },
        onError: (error) => ctx.runtime.error?.(`napcat gateway error: ${String(error)}`)
      });
      try {
        await gateway.start();
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "EADDRINUSE") {
          ctx.runtime.error?.(
            `napcat listen failed ${account.wsHost}:${account.wsPort}${account.wsPath} (address already in use)`
          );
        }
        throw err;
      }
      activeGateways.set(ctx.accountId, gateway);
      ctx.log?.info(`[${ctx.accountId}] NapCat gateway started`);
      return {
        stop: async () => {
          await gateway.stop();
          activeGateways.delete(ctx.accountId);
          ctx.log?.info(`[${ctx.accountId}] NapCat gateway stopped`);
        }
      };
    }
  }
};
