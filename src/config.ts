import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, NapcatAccountConfig, NapcatConfig, NapcatGroupConfig } from "./types.js";

const DEFAULTS = {
  wsMode: "forward" as const,
  wsHost: "127.0.0.1",
  wsPort: 3001,
  wsPath: "/",
  groupRequireMention: true,
  privateSlashCommandsEnabled: true,
  groupSlashCommandsEnabled: false,
  inboundLogEnabled: true,
  inboundLogDir: "./logs/napcat-inbound",
  inboundLogMaxLines: 2000,
  noReplyToken: "NO_REPLY"
};

function asObject(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return undefined;
  }
  return v as Record<string, unknown>;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  return v.map((entry) => String(entry).trim()).filter(Boolean);
}

function toAccountConfig(v: unknown): NapcatAccountConfig {
  const obj = asObject(v) ?? {};
  return {
    name: typeof obj.name === "string" ? obj.name : undefined,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
    wsMode: obj.wsMode === "forward" ? "forward" : obj.wsMode === "reverse" ? "reverse" : undefined,
    wsHost: typeof obj.wsHost === "string" ? obj.wsHost : undefined,
    wsPort: typeof obj.wsPort === "number" && Number.isFinite(obj.wsPort) ? obj.wsPort : undefined,
    wsPath: typeof obj.wsPath === "string" ? obj.wsPath : undefined,
    wsUrl: typeof obj.wsUrl === "string" ? obj.wsUrl : undefined,
    accessToken: typeof obj.accessToken === "string" ? obj.accessToken : undefined,
    ignoreSelfMessage: typeof obj.ignoreSelfMessage === "boolean" ? obj.ignoreSelfMessage : undefined,
    noReplyToken: typeof obj.noReplyToken === "string" ? obj.noReplyToken : undefined,
    dmPolicy:
      obj.dmPolicy === "disabled" ||
      obj.dmPolicy === "open" ||
      obj.dmPolicy === "allowlist" ||
      obj.dmPolicy === "pairing"
        ? obj.dmPolicy
        : undefined,
    allowFrom: asStringArray(obj.allowFrom),
    groupPolicy:
      obj.groupPolicy === "allowlist" || obj.groupPolicy === "open" || obj.groupPolicy === "disabled"
        ? obj.groupPolicy
        : undefined,
    groupRequireMention:
      typeof obj.groupRequireMention === "boolean" ? obj.groupRequireMention : undefined,
    privateSlashCommandsEnabled:
      typeof obj.privateSlashCommandsEnabled === "boolean"
        ? obj.privateSlashCommandsEnabled
        : undefined,
    groupSlashCommandsEnabled:
      typeof obj.groupSlashCommandsEnabled === "boolean"
        ? obj.groupSlashCommandsEnabled
        : undefined,
    groupAllowFrom: asStringArray(obj.groupAllowFrom),
    inboundLogEnabled: typeof obj.inboundLogEnabled === "boolean" ? obj.inboundLogEnabled : undefined,
    inboundLogDir: typeof obj.inboundLogDir === "string" ? obj.inboundLogDir : undefined,
    inboundLogMaxLines:
      typeof obj.inboundLogMaxLines === "number" && Number.isFinite(obj.inboundLogMaxLines)
        ? Math.floor(obj.inboundLogMaxLines)
        : undefined,
    groups: asObject(obj.groups) as NapcatConfig["groups"]
  };
}

function mergeAccountConfig(base: NapcatAccountConfig, override: NapcatAccountConfig): NapcatAccountConfig {
  return {
    name: override.name ?? base.name,
    enabled: override.enabled ?? base.enabled,
    wsMode: override.wsMode ?? base.wsMode,
    wsHost: override.wsHost ?? base.wsHost,
    wsPort: override.wsPort ?? base.wsPort,
    wsPath: override.wsPath ?? base.wsPath,
    wsUrl: override.wsUrl ?? base.wsUrl,
    accessToken: override.accessToken ?? base.accessToken,
    ignoreSelfMessage: override.ignoreSelfMessage ?? base.ignoreSelfMessage,
    noReplyToken: override.noReplyToken ?? base.noReplyToken,
    dmPolicy: override.dmPolicy ?? base.dmPolicy,
    allowFrom: override.allowFrom ?? base.allowFrom,
    groupPolicy: override.groupPolicy ?? base.groupPolicy,
    groupRequireMention: override.groupRequireMention ?? base.groupRequireMention,
    privateSlashCommandsEnabled:
      override.privateSlashCommandsEnabled ?? base.privateSlashCommandsEnabled,
    groupSlashCommandsEnabled:
      override.groupSlashCommandsEnabled ?? base.groupSlashCommandsEnabled,
    groupAllowFrom: override.groupAllowFrom ?? base.groupAllowFrom,
    inboundLogEnabled: override.inboundLogEnabled ?? base.inboundLogEnabled,
    inboundLogDir: override.inboundLogDir ?? base.inboundLogDir,
    inboundLogMaxLines: override.inboundLogMaxLines ?? base.inboundLogMaxLines,
    groups: {
      ...(base.groups ?? {}),
      ...(override.groups ?? {})
    }
  };
}

export function listNapcatAccountIds(cfg: CoreConfig): string[] {
  const accounts = asObject(cfg.channels?.napcat?.accounts);
  const ids = accounts ? Object.keys(accounts) : [];
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultNapcatAccountId(cfg: CoreConfig): string {
  const configuredDefault = cfg.channels?.napcat?.defaultAccountId;
  if (typeof configuredDefault === "string" && configuredDefault.trim()) {
    return normalizeAccountId(configuredDefault);
  }
  return DEFAULT_ACCOUNT_ID;
}

export type ResolvedNapcatAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  wsMode: "reverse" | "forward";
  wsHost: string;
  wsPort: number;
  wsPath: string;
  wsUrl?: string;
  accessToken?: string;
  ignoreSelfMessage: boolean;
  noReplyToken: string;
  dmPolicy: "disabled" | "open" | "allowlist" | "pairing";
  allowFrom: string[];
  groupPolicy: "disabled" | "allowlist" | "open";
  groupRequireMention: boolean;
  privateSlashCommandsEnabled: boolean;
  groupSlashCommandsEnabled: boolean;
  groupAllowFrom: string[];
  inboundLogEnabled: boolean;
  inboundLogDir: string;
  inboundLogMaxLines: number;
  groups: Record<string, NapcatGroupConfig>;
};

export function resolveNapcatAccount(params: {
  cfg: CoreConfig;
  accountId?: string;
}): ResolvedNapcatAccount {
  const accountId = normalizeAccountId(params.accountId ?? DEFAULT_ACCOUNT_ID);
  const section = toAccountConfig(params.cfg.channels?.napcat);
  const byIdRaw = asObject(params.cfg.channels?.napcat?.accounts)?.[accountId];
  const byId = toAccountConfig(byIdRaw);

  const merged = mergeAccountConfig(section, byId);
  const wsHost = merged.wsHost ?? DEFAULTS.wsHost;
  const wsPort = merged.wsPort ?? DEFAULTS.wsPort;
  const wsPath = merged.wsPath ?? DEFAULTS.wsPath;
  const wsUrl =
    merged.wsUrl && merged.wsUrl.trim() ? merged.wsUrl : `ws://${wsHost}:${wsPort}${wsPath}`;

  return {
    accountId,
    name: merged.name || `NapCat ${accountId}`,
    enabled: merged.enabled !== false,
    wsMode: merged.wsMode ?? DEFAULTS.wsMode,
    wsHost,
    wsPort,
    wsPath,
    wsUrl,
    accessToken: merged.accessToken,
    ignoreSelfMessage: merged.ignoreSelfMessage ?? true,
    noReplyToken: merged.noReplyToken ?? DEFAULTS.noReplyToken,
    dmPolicy: merged.dmPolicy ?? "pairing",
    allowFrom: merged.allowFrom ?? [],
    groupPolicy: merged.groupPolicy ?? "allowlist",
    groupRequireMention: merged.groupRequireMention ?? DEFAULTS.groupRequireMention,
    privateSlashCommandsEnabled:
      merged.privateSlashCommandsEnabled ?? DEFAULTS.privateSlashCommandsEnabled,
    groupSlashCommandsEnabled:
      merged.groupSlashCommandsEnabled ?? DEFAULTS.groupSlashCommandsEnabled,
    groupAllowFrom: merged.groupAllowFrom ?? [],
    inboundLogEnabled: merged.inboundLogEnabled ?? DEFAULTS.inboundLogEnabled,
    inboundLogDir: merged.inboundLogDir ?? DEFAULTS.inboundLogDir,
    inboundLogMaxLines:
      typeof merged.inboundLogMaxLines === "number" && merged.inboundLogMaxLines > 0
        ? merged.inboundLogMaxLines
        : DEFAULTS.inboundLogMaxLines,
    groups: (merged.groups ?? {}) as Record<string, NapcatGroupConfig>
  };
}

export function normalizeAllowlist(entries: string[] | undefined): string[] {
  if (!entries) {
    return [];
  }
  return entries.map((v) => v.trim().replace(/^qq:/i, "")).filter(Boolean);
}

export function isAllowedByAllowlist(allowlist: string[], qq: number): boolean {
  if (allowlist.length === 0) {
    return false;
  }
  return allowlist.includes(String(qq));
}
