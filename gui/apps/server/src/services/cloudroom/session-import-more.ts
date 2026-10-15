import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredEventRow } from "@cloudroom/db";
import type { AppDeps } from "../../types.js";
import { createThreadFromRequest } from "../threads/thread-create.js";
import { messagesSeed } from "../threads/thread-harness-switch.js";
import { compact, headLines, mapLimit, parseLine, readLines, shorten, tailLines, type Found, type Line, type Turn } from "./session-import.js";

export type MoreHarness = "pi" | "acp-hermes-agent";

const APPS: Record<MoreHarness, string> = { pi: "Pi", "acp-hermes-agent": "Hermes Agent" };
const piAgentDir = () => process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const piBridgeDir = () => process.env.BB_PI_BRIDGE_SESSION_DIR?.trim() || join(homedir(), ".bb", "pi-bridge-sessions");
const hermesDb = () => join(process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes"), "state.db");
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const isMoreHarness = (harness: string): harness is MoreHarness => harness in APPS;

export async function moreSessions(deps: AppDeps): Promise<Found[]> {
  await deps.providerRegistry.whenRegistrationsSettled();
  const scan = async (harness: MoreHarness, find: () => Promise<Found[]>) => {
    if (!deps.providerRegistry.get(harness)) return [];
    return find().catch((error: unknown) => {
      deps.logger.warn({ error, harness }, "Chat import scan failed");
      return [];
    });
  };
  return [...await scan("pi", piSessions), ...await scan("acp-hermes-agent", async () => hermesSessions())];
}

export async function moreTurns(session: Found): Promise<Turn[]> {
  return session.harness === "pi" ? piTurns(session.path) : hermesTurns(session.path, session.id);
}

export async function createMoreThread(deps: AppDeps, args: { hostId: string; projectId: string; session: Found; turns: Turn[]; history: StoredEventRow[] }) {
  const { session } = args;
  const app = APPS[session.harness as MoreHarness];
  const textOnly = session.harness === "acp-hermes-agent";
  const history = { kind: "rows" as const, rows: args.history };
  const messages = args.turns.flatMap((turn) => [{ role: "user" as const, text: turn.text }, ...turn.replies.map((reply) => ({ role: "agent" as const, text: reply.text }))]);
  const seed = textOnly ? await messagesSeed(deps.config.dataDir, args.projectId, messages, `[Cloudroom] This chat was imported from ${app} as text only. You are continuing it in a fresh session.`) : [];
  const sourceProviderThreadId = session.harness === "pi" ? await stagePiSession(session) : session.id;
  return createThreadFromRequest(deps, {
    projectId: args.projectId,
    providerId: session.harness,
    title: session.title,
    environment: { type: "host", hostId: args.hostId, workspace: { type: "unmanaged", path: null } },
    input: [{ type: "text", text: `Imported from ${app} session ${session.id}${textOnly ? " as text only" : ""}.`, mentions: [], visibility: "agent-only" }],
    origin: "sdk",
    startedOnBehalfOf: null,
  }, textOnly
    ? { providerInput: [], importedText: { history, seed } }
    : { providerInput: [], importedFork: { descriptor: { sourceProviderThreadId }, history } });
}

async function stagePiSession(session: Found): Promise<string> {
  if (!SAFE_ID.test(session.id)) throw new Error("This Pi chat has an invalid session ID.");
  const staged = `import-${session.id}`;
  await mkdir(piBridgeDir(), { recursive: true, mode: 0o700 });
  await copyFile(session.path, join(piBridgeDir(), `${staged}.jsonl`));
  return staged;
}

async function piSessions(): Promise<Found[]> {
  const root = join(piAgentDir(), "sessions");
  const files = (await readdir(root, { recursive: true }).catch(() => [] as string[])).filter((file) => file.endsWith(".jsonl"));
  return compact(await mapLimit(files, async (file): Promise<Found | null> => {
    const path = join(root, file);
    const lines = await headLines(path, 256 * 1024).catch(() => []);
    const header = lines[0];
    const first = lines.map(piUserText).find(Boolean);
    if (header?.type !== "session" || typeof header.id !== "string" || !SAFE_ID.test(header.id) || typeof header.cwd !== "string" || !first) return null;
    const name = [...await tailLines(path, 64 * 1024).catch(() => [])].reverse().find((line) => line.type === "session_info" && typeof line.name === "string")?.name as string | undefined;
    const updatedAt = (await stat(path).catch(() => null))?.mtimeMs;
    return updatedAt === undefined ? null : { harness: "pi", id: header.id, title: shorten(name || first), cwd: header.cwd, updatedAt, path };
  }));
}

async function piTurns(path: string): Promise<Turn[]> {
  const lines: Line[] = [];
  for await (const line of readLines(path)) if (line.type !== "session") lines.push(line);
  const linked = lines.filter((line) => typeof line.id === "string");
  const entries = new Map(linked.map((line) => [line.id as string, line]));
  const branch: Line[] = [];
  for (let entry = linked.at(-1); entry && branch.length <= linked.length; entry = entries.get(entry.parentId)) branch.push(entry);
  const turns: Turn[] = [];
  let model = "unknown";
  for (const entry of linked.length ? branch.reverse() : lines) {
    const at = Date.parse(entry.timestamp) || Date.now();
    const user = piUserText(entry);
    if (user) { turns.push({ at, text: user, model, replies: [] }); continue; }
    const message = entry.type === "message" && entry.message?.role === "assistant" ? entry.message : null;
    if (!message) continue;
    if (typeof message.model === "string") model = message.model;
    const last = turns.at(-1);
    if (last?.replies.length === 0) last.model = model;
    const text = contentText(message.content);
    if (text) last?.replies.push({ at, text });
  }
  return turns;
}

function piUserText(line: Line): string | null {
  return line.type === "message" && line.message?.role === "user" ? contentText(line.message.content) : null;
}

function hermesSessions(): Found[] {
  const path = hermesDb();
  if (!existsSync(path)) return [];
  return withHermes(path, (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((column) => column.name));
    const optional = (name: string) => (columns.has(name) ? `s.${name}` : "NULL");
    const rows = db.prepare(`
      SELECT s.id, ${optional("title")} AS title, ${optional("cwd")} AS cwd,
        (SELECT content FROM messages WHERE session_id = s.id AND role = 'user' ORDER BY timestamp, id LIMIT 1) AS first,
        (SELECT MAX(timestamp) FROM messages WHERE session_id = s.id) AS lastAt
      FROM sessions s
      WHERE s.source NOT IN ('acp', 'cron', 'subagent', 'delegate') AND COALESCE(${optional("archived")}, 0) = 0
    `).all() as { id: string; title: string | null; cwd: string | null; first: unknown; lastAt: number | null }[];
    return compact(rows.map((row): Found | null => {
      const first = hermesText(row.first);
      if (!first || row.lastAt === null) return null;
      const cwd = row.cwd && existsSync(row.cwd) ? row.cwd : homedir();
      return { harness: "acp-hermes-agent", id: row.id, title: shorten(row.title || first), cwd, updatedAt: row.lastAt * 1000, path };
    }));
  });
}

function hermesTurns(path: string, id: string): Turn[] {
  return withHermes(path, (db) => {
    const model = (db.prepare("SELECT model FROM sessions WHERE id = ?").get(id) as { model: string | null } | undefined)?.model || "unknown";
    const rows = db.prepare("SELECT role, content, timestamp FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY timestamp, id").all(id) as { role: string; content: unknown; timestamp: number }[];
    const turns: Turn[] = [];
    for (const row of rows) {
      const text = hermesText(row.content);
      if (!text) continue;
      if (row.role === "user") turns.push({ at: row.timestamp * 1000, text, model, replies: [] });
      else turns.at(-1)?.replies.push({ at: row.timestamp * 1000, text });
    }
    return turns;
  });
}

function withHermes<T>(path: string, read: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function hermesText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const parts = content.startsWith("[{") ? parseLine(content) : null;
  return Array.isArray(parts) ? contentText(parts) : content.trim() || null;
}

function contentText(content: unknown): string | null {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.filter((part: Line) => part?.type === "text" && typeof part.text === "string").map((part: Line) => part.text).join("\n") : "";
  return text.trim() || null;
}
