import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvironment, getThread } from "@cloudroom/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importNativeSessions, listNativeSessions } from "../../src/services/cloudroom/session-import.js";
import { resolveDeferredFirstTurnContext } from "../../src/services/threads/deferred-first-turn-context.js";
import { pendingImportFork } from "../../src/services/threads/thread-fork-history.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { threadMessages } from "../../src/services/threads/thread-transcript.js";
import { reportQueuedCommandSuccess, waitForQueuedCommand } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => vi.unstubAllEnvs());

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), "import-more-"));
  const project = join(root, "project");
  const piDir = join(root, "pi", "sessions", "--project--");
  for (const dir of [project, piDir, join(root, "hermes"), join(root, "hermes-project"), join(root, "claude-project"), join(root, "claude", "projects", "-claude-project")]) {
    await mkdir(dir, { recursive: true });
  }
  for (const [name, value] of [["PI_CODING_AGENT_DIR", "pi"], ["BB_PI_BRIDGE_SESSION_DIR", "pi-bridge"], ["HERMES_HOME", "hermes"], ["CLAUDE_CONFIG_DIR", "claude"], ["CODEX_HOME", "codex"]]) {
    vi.stubEnv(name!, join(root, value!));
  }
  const at = (second: number) => `2026-10-01T10:00:0${second}.000Z`;
  await writeFile(join(piDir, "2026-10-01_pi-1.jsonl"), [
    { type: "session", version: 3, id: "pi-1", timestamp: at(0), cwd: project },
    { type: "message", id: "a1", parentId: null, timestamp: at(1), message: { role: "user", content: "Fix the login bug" } },
    { type: "message", id: "a2", parentId: "a1", timestamp: at(2), message: { role: "assistant", model: "sonnet", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } },
    { type: "message", id: "a3", parentId: "a2", timestamp: at(3), message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "TOOL_RESULT_TEXT" }] } },
    { type: "message", id: "a4", parentId: "a3", timestamp: at(4), message: { role: "assistant", model: "sonnet", content: [{ type: "text", text: "Fixed it." }] } },
    { type: "message", id: "b1", parentId: "a4", timestamp: at(5), message: { role: "user", content: [{ type: "text", text: "Abandoned branch" }] } },
    { type: "message", id: "a5", parentId: "a4", timestamp: at(6), message: { role: "user", content: [{ type: "text", text: "Now add a test" }] } },
    { type: "session_info", id: "a6", parentId: "a5", timestamp: at(7), name: "Login fix" },
  ].map((line) => JSON.stringify(line)).join("\n"));
  await writeFile(join(root, "claude", "projects", "-claude-project", "claude-1.jsonl"), [
    { type: "user", cwd: join(root, "claude-project"), timestamp: at(1), message: { role: "user", content: "Refactor the API" } },
    { type: "assistant", timestamp: at(2), message: { model: "claude-test", content: [{ type: "text", text: "Done refactoring." }] } },
  ].map((line) => JSON.stringify(line)).join("\n"));
  await writeFile(join(piDir, "2026-09-01_pi-old.jsonl"), [
    { type: "session", id: "pi-old", timestamp: at(0), cwd: project },
    { type: "message", timestamp: at(1), message: { role: "user", content: "Old format question" } },
    { type: "message", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Old format answer" }] } },
  ].map((line) => JSON.stringify(line)).join("\n"));
  await writeFile(join(piDir, "2026-09-02_bad.jsonl"), JSON.stringify({ type: "session", id: "../victim", cwd: project }) + "\n" + JSON.stringify({ type: "message", id: "x", parentId: null, message: { role: "user", content: "Escape" } }));
  await mkdir(join(piDir, "unreadable.jsonl"));
  const db = new Database(join(root, "hermes", "state.db"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL, title TEXT, cwd TEXT, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`);
  const session = db.prepare("INSERT INTO sessions (id, source, model, started_at, title, cwd) VALUES (?, ?, 'hermes-4', 1, ?, ?)");
  const message = db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
  session.run("h-cli", "cli", "Deploy plan", join(root, "hermes-project"));
  [["user", "Plan the deploy"], ["assistant", null], ["tool", "TOOL_RESULT_TEXT"], ["assistant", "Here is the plan."]].forEach(([role, content], index) => message.run("h-cli", role, content, 1_800_000_000 + index));
  session.run("h-telegram", "telegram", null, null);
  message.run("h-telegram", "user", JSON.stringify([{ type: "text", text: "Hi from Telegram" }]), 1_700_000_000);
  for (const source of ["cron", "acp"]) {
    session.run(`h-${source}`, source, null, project);
    message.run(`h-${source}`, "user", "Skip me", 1_700_000_000);
  }
  db.close();
  return { root, project };
}

async function sendFirstMessage(harness: TestAppHarness, threadId: string) {
  const deferred = resolveDeferredFirstTurnContext(harness.deps.db, threadId);
  const fork = pendingImportFork(harness.deps.db, threadId);
  const thread = getThread(harness.deps.db, threadId)!;
  await sendThreadMessage(harness.deps, {
    environment: getEnvironment(harness.deps.db, thread.environmentId!)!,
    payload: { input: textInput("What's next?"), mode: "start", model: "default", permissionMode: "full", reasoningLevel: "medium", serviceTier: "default" },
    thread,
    trigger: "user",
  });
  const start = await waitForQueuedCommand(harness, ({ command }) => command.type === "thread.start" && command.threadId === threadId);
  if (start.command.type !== "thread.start") throw new Error("Expected thread.start");
  const sent = start.command.input.map((part) => (part.type === "text" ? part.text : part.type)).join("\n");
  return { deferred, fork, startFork: start.command.fork, sent };
}

describe("Pi and Hermes chat import", () => {
  it("lists every app, forks Claude Code and Pi on the first message, and hands Hermes the text", async () => {
    const { root, project } = await fixtures();
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-import-more" });
      const sessions = await listNativeSessions(harness.deps);
      expect(sessions.map(({ harness: app, id, title, cwd }) => [app, id, title, cwd]).sort((a, b) => a[1]!.localeCompare(b[1]!))).toEqual([
        ["claude-code", "claude-1", "Refactor the API", join(root, "claude-project")],
        ["acp-hermes-agent", "h-cli", "Deploy plan", join(root, "hermes-project")],
        ["acp-hermes-agent", "h-telegram", "Hi from Telegram", homedir()],
        ["pi", "pi-1", "Login fix", project],
        ["pi", "pi-old", "Old format question", project],
      ]);

      let importing = true;
      const attaching = (async () => {
        while (importing) {
          const queued = await waitForQueuedCommand(harness, ({ command }) => command.type === "environment.attach" || command.type === "project.inspect", 100).catch(() => null);
          if (queued?.command.type === "project.inspect") await reportQueuedCommandSuccess(harness, queued, { path: queued.command.path, gitRemoteUrl: null });
          if (queued?.command.type === "environment.attach") {
            await reportQueuedCommandSuccess(harness, queued, { path: queued.command.path, isGitRepo: true, isWorktree: false, branchName: "main", defaultBranch: "main", transcript: [] });
          }
        }
      })();
      const result = await importNativeSessions(harness.deps, host.id, [
        { harness: "claude-code", id: "claude-1" },
        { harness: "pi", id: "pi-1" },
        { harness: "pi", id: "pi-old" },
        { harness: "acp-hermes-agent", id: "h-cli" },
      ]);
      importing = false;
      await attaching;
      expect(result.skipped).toEqual([]);
      const threadId = (id: string) => result.imported.find((entry) => entry.id === id)!.threadId;

      const claude = await sendFirstMessage(harness, threadId("claude-1"));
      expect(claude.fork).toEqual({ sourceProviderThreadId: "claude-1" });
      expect(claude.deferred).toBeNull();
      expect(claude.startFork).toEqual({ sourceProviderThreadId: "claude-1" });
      expect(claude.sent).toBe("What's next?");

      expect(threadMessages(harness.deps.db, threadId("pi-1"))).toEqual([
        { role: "user", text: "Fix the login bug" },
        { role: "agent", text: "Fixed it." },
        { role: "user", text: "Now add a test" },
      ]);
      expect(threadMessages(harness.deps.db, threadId("pi-old"))).toEqual([
        { role: "user", text: "Old format question" },
        { role: "agent", text: "Old format answer" },
      ]);
      expect(existsSync(join(root, "pi-bridge", "import-pi-1.jsonl"))).toBe(true);
      const pi = await sendFirstMessage(harness, threadId("pi-1"));
      expect(pi.fork).toEqual({ sourceProviderThreadId: "import-pi-1" });
      expect(pi.deferred).toBeNull();
      expect(pi.startFork).toEqual({ sourceProviderThreadId: "import-pi-1" });
      expect(pi.sent).toBe("What's next?");

      const hermes = await sendFirstMessage(harness, threadId("h-cli"));
      expect(hermes.fork).toBeNull();
      expect(hermes.startFork).toBeUndefined();
      expect(hermes.sent).toContain("imported from Hermes Agent as text only");
      expect(hermes.sent).toContain("Plan the deploy");
      expect(hermes.sent).toContain("Here is the plan.");
      expect(hermes.sent).toContain("What's next?");
      expect(hermes.sent).not.toContain("TOOL_RESULT_TEXT");
    });
  }, 60_000);
});
