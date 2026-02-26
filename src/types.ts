import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";

export type ChatType = "private" | "group";

export interface SenderMeta {
  qq: number;
  nickname: string;
  role: "owner" | "admin" | "member" | "unknown";
}

export interface NapcatInboundMessage {
  chatType: ChatType;
  text: string;
  wasAtSelf: boolean;
  selfQq?: number;
  messageId?: number | string;
  userQq: number;
  userNickname: string;
  userCard?: string;
  userTitle?: string;
  userRole: SenderMeta["role"];
  groupId?: number;
  groupName?: string;
  rawEvent: unknown;
  timestamp: number;
}

export type NapcatGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
  skills?: string[];
};

export type NapcatAccountConfig = {
  name?: string;
  enabled?: boolean;
  wsMode?: "reverse" | "forward";
  wsHost?: string;
  wsPort?: number;
  wsPath?: string;
  wsUrl?: string;
  accessToken?: string;
  ignoreSelfMessage?: boolean;
  noReplyToken?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupPolicy?: GroupPolicy;
  groupRequireMention?: boolean;
  groupAllowFrom?: string[];
  groups?: Record<string, NapcatGroupConfig>;
  inboundLogEnabled?: boolean;
  inboundLogDir?: string;
  inboundLogMaxLines?: number;
};

export type NapcatConfig = {
  defaultAccountId?: string;
  accounts?: Record<string, NapcatAccountConfig>;
} & NapcatAccountConfig;

export type CoreConfig = {
  channels?: {
    napcat?: NapcatConfig;
  };
  [key: string]: unknown;
};

export interface OneBotSender {
  user_id: number;
  nickname?: string;
  card?: string;
  role?: "owner" | "admin" | "member";
}

export interface OneBotMessageEvent {
  post_type: "message";
  time?: number;
  self_id?: number;
  message_type: "private" | "group";
  sub_type?: string;
  message_id?: number | string;
  user_id: number;
  group_id?: number;
  message?: string | OneBotMessageSegment[];
  raw_message?: string;
  sender?: OneBotSender;
}

export interface OneBotMessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotApiResponse<T = unknown> {
  status: "ok" | "failed";
  retcode: number;
  data?: T;
  msg?: string;
  wording?: string;
  echo?: string;
}
