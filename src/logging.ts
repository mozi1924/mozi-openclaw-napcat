import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";

function sanitizeToken(raw: string): string {
  return String(raw || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function resolveInboundLogPath(params: {
  dir: string;
  chatType: "private" | "group";
  userQq: number;
  groupId?: number;
}): string {
  const raw = (params.dir || "./logs/napcat-inbound").trim();
  const expanded = raw.startsWith("~/") ? resolve(os.homedir(), raw.slice(2)) : raw;
  const base = resolve(expanded);
  if (params.chatType === "group") {
    return resolve(base, `group-${sanitizeToken(String(params.groupId || "unknown"))}.log`);
  }
  return resolve(base, `qq-${sanitizeToken(String(params.userQq))}.log`);
}

async function capJsonlLines(filePath: string, maxLines: number): Promise<void> {
  if (maxLines <= 0) {
    return;
  }
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length <= maxLines) {
      return;
    }
    const keep = lines.slice(lines.length - maxLines).join("\n") + "\n";
    await writeFile(filePath, keep, "utf8");
  } catch {
    // ignore
  }
}

export async function appendInboundLog(params: {
  filePath: string;
  maxLines: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  const line = `${JSON.stringify(params.payload)}\n`;
  await mkdir(dirname(params.filePath), { recursive: true });
  await appendFile(params.filePath, line, "utf8");
  await capJsonlLines(params.filePath, params.maxLines);
}
