import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type {
  NapcatInboundMessage,
  OneBotApiResponse,
  OneBotMessageEvent,
  OneBotMessageSegment,
  SenderMeta
} from "./types.js";

type WsMode = "reverse" | "forward";

type ApiResolve = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

type GatewayOptions = {
  wsMode: WsMode;
  wsHost: string;
  wsPort: number;
  wsPath: string;
  wsUrl?: string;
  accessToken?: string;
  ignoreSelfMessage?: boolean;
  onMessage: (message: NapcatInboundMessage) => Promise<void> | void;
  onError?: (error: unknown) => void;
};

function toRole(role?: string): SenderMeta["role"] {
  if (role === "owner" || role === "admin" || role === "member") {
    return role;
  }
  return "unknown";
}

function getSegmentText(segments: OneBotMessageSegment[]): string {
  const chunks: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      const t = seg.data?.text;
      if (typeof t === "string") {
        chunks.push(t);
      }
    }
  }
  return chunks.join("").trim();
}

function extractText(event: OneBotMessageEvent): string {
  const raw = (event.raw_message ?? "").trim();
  if (raw) {
    return raw;
  }
  if (typeof event.message === "string") {
    return event.message.trim();
  }
  if (Array.isArray(event.message)) {
    return getSegmentText(event.message);
  }
  return "";
}

function isAtSelf(event: OneBotMessageEvent): boolean {
  if (event.message_type !== "group" || !event.self_id) {
    return false;
  }
  if (Array.isArray(event.message)) {
    return event.message.some((seg) => {
      if (seg.type !== "at") {
        return false;
      }
      const qq = seg.data?.qq;
      return String(qq) === String(event.self_id);
    });
  }
  return (event.raw_message ?? "").includes(`[CQ:at,qq=${event.self_id}]`);
}

function eventTimestampMs(event: OneBotMessageEvent): number {
  if (typeof event.time === "number" && Number.isFinite(event.time) && event.time > 0) {
    return event.time > 1_000_000_000_000 ? Math.floor(event.time) : Math.floor(event.time * 1000);
  }
  return Date.now();
}

function appendAccessTokenToUrl(rawUrl: string, token?: string): string {
  if (!token) {
    return rawUrl;
  }
  try {
    const u = new URL(rawUrl);
    if (!u.searchParams.get("access_token")) {
      u.searchParams.set("access_token", token);
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export class NapcatGateway {
  private readonly pendingApi = new Map<string, ApiResolve>();
  private readonly groupNameCache = new Map<number, string>();
  private readonly groupMemberCache = new Map<
    string,
    { card?: string; nickname?: string; role?: string; title?: string; special_title?: string; at: number }
  >();
  private ws: WebSocket | null = null;
  private wss: WebSocketServer | null = null;
  private closed = false;

  constructor(private readonly options: GatewayOptions) {}

  async start(): Promise<void> {
    if (this.wss || this.ws) {
      return;
    }
    if (this.options.wsMode === "reverse") {
      await this.startReverseServer();
      return;
    }
    await this.startForwardClient();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
      this.wss = null;
    }
    for (const [echo, pending] of this.pendingApi) {
      clearTimeout(pending.timer);
      pending.reject(new Error("NapCat gateway stopped"));
      this.pendingApi.delete(echo);
    }
  }

  async sendPrivateMessage(userId: number, text: string): Promise<void> {
    await this.callAction("send_private_msg", { user_id: userId, message: text });
  }

  async sendGroupMessage(groupId: number, text: string): Promise<void> {
    await this.callAction("send_group_msg", { group_id: groupId, message: text });
  }

  async getGroupInfo(groupId: number): Promise<{ group_id?: number; group_name?: string }> {
    return (await this.callAction("get_group_info", { group_id: groupId, no_cache: false })) as {
      group_id?: number;
      group_name?: string;
    };
  }

  async getGroupList(): Promise<Array<{ group_id?: number; group_name?: string }>> {
    const data = (await this.callAction("get_group_list", { no_cache: false })) as unknown;
    return Array.isArray(data) ? (data as Array<{ group_id?: number; group_name?: string }>) : [];
  }

  async getFriendList(): Promise<Array<{ user_id?: number; nickname?: string; remark?: string }>> {
    const data = (await this.callAction("get_friend_list", { no_cache: false })) as unknown;
    return Array.isArray(data)
      ? (data as Array<{ user_id?: number; nickname?: string; remark?: string }>)
      : [];
  }

  async getStrangerInfo(userId: number): Promise<{ user_id?: number; nickname?: string }> {
    return (await this.callAction("get_stranger_info", {
      user_id: userId,
      no_cache: false
    })) as { user_id?: number; nickname?: string };
  }

  async friendPoke(userId: number): Promise<void> {
    await this.callAction("friend_poke", { user_id: userId });
  }

  async groupPoke(groupId: number, userId: number): Promise<void> {
    await this.callAction("group_poke", { group_id: groupId, user_id: userId });
  }

  async setInputStatus(userId: number, eventType: number): Promise<void> {
    await this.callAction("set_input_status", { user_id: userId, event_type: eventType });
  }

  async setGroupBan(groupId: number, userId: number, duration: number): Promise<void> {
    await this.callAction("set_group_ban", { group_id: groupId, user_id: userId, duration });
  }

  async setGroupKick(groupId: number, userId: number): Promise<void> {
    await this.callAction("set_group_kick", {
      group_id: groupId,
      user_id: userId,
      reject_add_request: false
    });
  }

  async getGroupAtAllRemain(groupId: number): Promise<{ can_at_all?: boolean; remain_at_all_count_for_group?: number }> {
    return (await this.callAction("get_group_at_all_remain", { group_id: groupId })) as {
      can_at_all?: boolean;
      remain_at_all_count_for_group?: number;
    };
  }

  async getGroupShutList(groupId: number): Promise<unknown[]> {
    const data = (await this.callAction("get_group_shut_list", { group_id: groupId })) as unknown;
    return Array.isArray(data) ? data : [];
  }

  private async waitUntilConnected(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`napcat websocket not connected (waited ${timeoutMs}ms)`);
  }

  private async startReverseServer(): Promise<void> {
    const wss = new WebSocketServer({
      host: this.options.wsHost,
      port: this.options.wsPort,
      path: this.options.wsPath
    });
    this.wss = wss;

    wss.on("connection", (socket, req) => {
      if (!this.authPass(req)) {
        socket.close(1008, "Unauthorized");
        return;
      }
      this.attachSocket(socket);
      console.log("[napcat] reverse websocket connected");
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        wss.off("error", onError);
        console.log(
          `[napcat] reverse websocket listening ws://${this.options.wsHost}:${this.options.wsPort}${this.options.wsPath}`
        );
        resolve();
      };
      const onError = (err: Error) => {
        wss.off("listening", onListening);
        if (this.wss === wss) {
          this.wss = null;
        }
        try {
          wss.close();
        } catch {
          // ignore
        }
        this.options.onError?.(err);
        reject(err);
      };
      wss.once("listening", onListening);
      wss.once("error", onError);
    });

    wss.on("error", (err) => {
      this.options.onError?.(err);
    });
  }

  private async startForwardClient(): Promise<void> {
    if (!this.options.wsUrl) {
      throw new Error("wsUrl is required when wsMode=forward");
    }
    const wsUrl = appendAccessTokenToUrl(this.options.wsUrl, this.options.accessToken);
    const headers: Record<string, string> = {};
    if (this.options.accessToken) {
      headers.Authorization = `Bearer ${this.options.accessToken}`;
    }

    const socket = new WebSocket(wsUrl, { headers });
    socket.on("open", () => {
      console.log(`[napcat] forward websocket connected ${wsUrl}`);
      this.attachSocket(socket);
    });
    socket.on("close", () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      if (!this.closed) {
        setTimeout(() => {
          this.startForwardClient().catch((err) => this.options.onError?.(err));
        }, 3000);
      }
    });
    socket.on("error", (err) => this.options.onError?.(err));
  }

  private authPass(req: IncomingMessage): boolean {
    if (!this.options.accessToken) {
      return true;
    }
    const auth = req.headers.authorization ?? "";
    const headerPass = auth === `Bearer ${this.options.accessToken}` || auth === this.options.accessToken;
    if (headerPass) {
      return true;
    }
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      return reqUrl.searchParams.get("access_token") === this.options.accessToken;
    } catch {
      return false;
    }
  }

  private attachSocket(socket: WebSocket): void {
    this.ws = socket;
    socket.on("message", (buffer) => {
      const raw = buffer.toString();
      this.handlePayload(raw).catch((err) => this.options.onError?.(err));
    });
    socket.on("close", () => {
      if (this.ws === socket) {
        this.ws = null;
      }
    });
  }

  private async handlePayload(raw: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof payload !== "object" || payload === null) {
      return;
    }

    const maybeApi = payload as Partial<OneBotApiResponse>;
    if (typeof maybeApi.status === "string" && typeof maybeApi.echo === "string") {
      this.resolveApi(maybeApi.echo, payload);
      return;
    }

    const evt = payload as Partial<OneBotMessageEvent> & {
      notice_type?: string;
      sub_type?: string;
      group_id?: number;
      user_id?: number;
      target_id?: number;
      time?: number;
    };
    if (evt.post_type === "message" && (evt.message_type === "private" || evt.message_type === "group")) {
      await this.handleMessageEvent(evt as OneBotMessageEvent, payload);
      return;
    }
    if (evt.post_type === "notice") {
      await this.handleNoticeEvent(evt, payload);
    }
  }

  private async handleMessageEvent(event: OneBotMessageEvent, rawEvent: unknown): Promise<void> {
    if (this.options.ignoreSelfMessage !== false && event.self_id && event.user_id === event.self_id) {
      return;
    }

    const text = extractText(event);
    if (!text) {
      return;
    }

    const senderQq = event.user_id;
    let card = event.sender?.card;
    let nickname = event.sender?.nickname || `QQ${senderQq}`;
    let role = toRole(event.sender?.role);
    const timestamp = eventTimestampMs(event);

    if (event.message_type === "private") {
      await this.options.onMessage({
        chatType: "private",
        text,
        wasAtSelf: false,
        selfQq: event.self_id,
        messageId: event.message_id,
        userQq: senderQq,
        userNickname: nickname,
        userCard: card,
        userRole: role,
        rawEvent,
        timestamp
      });
      return;
    }

    if (!event.group_id) {
      return;
    }

    const groupName = await this.getGroupName(event.group_id);
    const memberInfo = await this.getGroupMemberInfo(event.group_id, senderQq);
    if (memberInfo.card && memberInfo.card.trim()) {
      card = memberInfo.card.trim();
    }
    if (memberInfo.nickname && memberInfo.nickname.trim()) {
      nickname = memberInfo.nickname.trim();
    }
    if (memberInfo.role) {
      role = toRole(memberInfo.role);
    }
    await this.options.onMessage({
      chatType: "group",
      text,
      wasAtSelf: isAtSelf(event),
      selfQq: event.self_id,
      messageId: event.message_id,
      userQq: senderQq,
      userNickname: nickname,
      userCard: card,
      userTitle: memberInfo.title?.trim() || memberInfo.special_title?.trim() || undefined,
      userRole: role,
      groupId: event.group_id,
      groupName,
      rawEvent,
      timestamp
    });
  }

  private async getGroupName(groupId: number): Promise<string> {
    const cached = this.groupNameCache.get(groupId);
    if (cached) {
      return cached;
    }
    try {
      const data = (await this.callAction("get_group_info", {
        group_id: groupId,
        no_cache: false
      })) as { group_name?: string };
      const name = data?.group_name || `Group${groupId}`;
      this.groupNameCache.set(groupId, name);
      return name;
    } catch {
      return `Group${groupId}`;
    }
  }

  private async getGroupMemberInfo(
    groupId: number,
    userId: number
  ): Promise<{ card?: string; nickname?: string; role?: string; title?: string; special_title?: string }> {
    const key = `${groupId}:${userId}`;
    const cached = this.groupMemberCache.get(key);
    if (cached && Date.now() - cached.at < 30_000) {
      return {
        card: cached.card,
        nickname: cached.nickname,
        role: cached.role,
        title: cached.title,
        special_title: cached.special_title
      };
    }
    try {
      const data = (await this.callAction("get_group_member_info", {
        group_id: groupId,
        user_id: userId,
        no_cache: false
      })) as { card?: string; nickname?: string; role?: string; title?: string; special_title?: string };
      this.groupMemberCache.set(key, {
        card: data?.card,
        nickname: data?.nickname,
        role: data?.role,
        title: data?.title,
        special_title: data?.special_title,
        at: Date.now()
      });
      return data ?? {};
    } catch {
      return {};
    }
  }

  private async handleNoticeEvent(
    event: Partial<OneBotMessageEvent> & {
      notice_type?: string;
      sub_type?: string;
      group_id?: number;
      user_id?: number;
      target_id?: number;
      time?: number;
      self_id?: number;
    },
    rawEvent: unknown
  ): Promise<void> {
    const isPoke = event.notice_type === "poke" || (event.notice_type === "notify" && event.sub_type === "poke");
    if (!isPoke || !event.user_id || !event.target_id || !event.self_id) {
      return;
    }
    if (event.target_id !== event.self_id) {
      return;
    }

    const senderQq = event.user_id;
    const timestamp =
      typeof event.time === "number" && Number.isFinite(event.time) && event.time > 0
        ? event.time > 1_000_000_000_000
          ? Math.floor(event.time)
          : Math.floor(event.time * 1000)
        : Date.now();
    if (event.group_id) {
      const groupName = await this.getGroupName(event.group_id);
      const member = await this.getGroupMemberInfo(event.group_id, senderQq);
      const nickname = member.nickname?.trim() || `QQ${senderQq}`;
      await this.options.onMessage({
        chatType: "group",
        text: "__SYSTEM_POKE__",
        wasAtSelf: true,
        selfQq: event.self_id,
        userQq: senderQq,
        userNickname: nickname,
        userCard: member.card?.trim() || undefined,
        userTitle: member.title?.trim() || member.special_title?.trim() || undefined,
        userRole: toRole(member.role),
        groupId: event.group_id,
        groupName,
        rawEvent,
        timestamp
      });
      return;
    }

    let nickname = `QQ${senderQq}`;
    try {
      const stranger = await this.getStrangerInfo(senderQq);
      if (stranger.nickname?.trim()) {
        nickname = stranger.nickname.trim();
      }
    } catch {
      // ignore
    }
    await this.options.onMessage({
      chatType: "private",
      text: "__SYSTEM_POKE__",
      wasAtSelf: false,
      selfQq: event.self_id,
      userQq: senderQq,
      userNickname: nickname,
      userRole: "unknown",
      rawEvent,
      timestamp
    });
  }

  private async callAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.waitUntilConnected();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("napcat websocket not connected");
    }
    const echo = randomUUID();
    const payload = JSON.stringify({ action, params, echo });

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApi.delete(echo);
        reject(new Error(`OneBot action timeout: ${action}`));
      }, 10000);
      this.pendingApi.set(echo, { resolve, reject, timer });
    });

    this.ws.send(payload);
    const raw = (await response) as OneBotApiResponse;
    if (raw.status !== "ok") {
      throw new Error(`OneBot action failed ${action}: ${raw.msg ?? raw.wording ?? "unknown error"}`);
    }
    return raw.data;
  }

  private resolveApi(echo: string, payload: unknown): void {
    const pending = this.pendingApi.get(echo);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingApi.delete(echo);
    pending.resolve(payload);
  }
}
