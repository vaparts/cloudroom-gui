import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import type { ThreadEvent } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { setInstructionsDataDir } from "./src/instructions.js";
import {
  BASE_OPTIONS,
  BridgeSession,
  PERMISSION_OPTIONS,
  creq,
  textInput,
  useFakeAgy,
} from "./test/harness.js";

type Item = Extract<ThreadEvent, { type: "item/completed" }>["item"];

let restoreAgy: () => void;
let dataDir: string;
let threadCounter = 0;
const open: BridgeSession[] = [];

beforeAll(() => {
  restoreAgy = useFakeAgy();
  dataDir = mkdtempSync(join(tmpdir(), "agy-bridge-data-"));
  setInstructionsDataDir(dataDir);
});

afterAll(() => {
  restoreAgy();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const session of open.splice(0)) {
    await session.request("thread/stop", {
      threadId: session.threadId,
      providerThreadId: "",
      activeTurnId: null,
      intent: "release",
    });
    session.dispose();
  }
});

function session(): BridgeSession {
  threadCounter += 1;
  const created = new BridgeSession(`thr_agy_stream_${threadCounter}`);
  open.push(created);
  return created;
}

function completedItems(events: ThreadEvent[]): Item[] {
  return events.flatMap((event) =>
    event.type === "item/completed" ? [event.item] : [],
  );
}

function turnStatuses(events: ThreadEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "turn/completed" ? [String(event.status)] : [],
  );
}

function flagValue(
  argv: string[] | undefined,
  flag: string,
): string | undefined {
  const index = argv?.indexOf(flag) ?? -1;
  return index >= 0 ? argv?.[index + 1] : undefined;
}

describe("handshake", () => {
  it("advertises provider-enforced approvals and queued steering", async () => {
    const s = session();
    const result = await s.ok("initialize", {
      protocolVersion: 2,
      client: { name: "agy-stream-test", version: "0.0.0" },
      grammarVersions: [3, 3],
    });
    expect(result.capabilities).toMatchObject({
      grammarVersions: [3, 3],
      sessionRestore: true,
      approvalEnforcedBy: "provider",
      steerMode: "queue",
      fork: "none",
    });
  });
});

describe("turns", () => {
  it("streams a reply and reports usage", async () => {
    const s = session();
    const providerThreadId = await s.start();
    expect(
      s.harness.messages.find((m) => m.method === "thread/identity")?.params,
    ).toEqual({
      threadId: s.threadId,
      providerThreadId,
    });
    await s.turn(providerThreadId, "hello", creq(1));
    await s.waitForTurns(1);

    const types = s.pump().map((event) => event.type);
    expect(types.slice(0, 2)).toEqual(["turn/started", "turn/input/accepted"]);
    expect(types.at(-1)).toBe("turn/completed");
    expect(types).toContain("thread/tokenUsage/updated");
    expect(completedItems(s.pump())).toEqual([
      expect.objectContaining({ type: "agentMessage", text: "echo: hello\n" }),
    ]);
    expect(turnStatuses(s.pump())).toEqual(["completed"]);
  });

  it("renders an agy tool step as a tool call", async () => {
    const s = session();
    const providerThreadId = await s.start();
    await s.turn(providerThreadId, "tool read the note", creq(2));
    await s.waitForTurns(1);

    const [tool, message] = completedItems(s.pump());
    expect(tool).toMatchObject({
      type: "toolCall",
      tool: "view_file",
      arguments: { AbsolutePath: "/tmp/note.txt" },
      result: "2 lines, 27 bytes",
      status: "completed",
      presentation: { icon: { glyph: "FileText" } },
    });
    expect(message).toMatchObject({ type: "agentMessage" });
  });

  it("fails the turn and shows agy's error when agy reports ERROR", async () => {
    const s = session();
    const providerThreadId = await s.start();
    await s.turn(providerThreadId, "fail please", creq(3));
    await s.waitForTurns(1);

    expect(turnStatuses(s.pump())).toEqual(["failed"]);
    expect(completedItems(s.pump())).toEqual([
      expect.objectContaining({
        type: "agentMessage",
        text: "agy error: boom",
      }),
    ]);
  });

  it("fails the turn with agy's reason when headless agy denies a tool", async () => {
    const s = session();
    const providerThreadId = await s.start();
    await s.turn(providerThreadId, "denied run uname", creq(3));
    await s.waitForTurns(1);

    expect(turnStatuses(s.pump())).toEqual(["failed"]);
    expect(completedItems(s.pump()).at(-1)).toMatchObject({
      type: "agentMessage",
      text: expect.stringMatching(
        /^agy error: no output produced .*auto-denied/u,
      ),
    });
  });

  it("answers thread/start with agy's own error when agy cannot start", async () => {
    const s = session();
    const response = await s.request("thread/start", {
      threadId: s.threadId,
      cwd: s.cwd,
      instructionMode: "append",
      options: { ...BASE_OPTIONS, model: "fail-to-start" },
    });
    expect(response.error).toMatchObject({
      code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    });
    expect(JSON.stringify(response.error)).toContain("not signed in");
  });
});

describe("launch flags", () => {
  it("passes the base model and the reasoning level as --effort", async () => {
    const s = session();
    await s.start({
      model: "gemini-4-argon",
      reasoningLevel: "high",
      permissionMode: "full",
    });
    const [argv] = s.argvLog();
    expect(flagValue(argv, "--model")).toBe("gemini-4-argon");
    expect(flagValue(argv, "--effort")).toBe("high");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv?.at(-1)).toBe("-p=");
  });

  it("never combines an effort-suffixed (legacy) model id with --effort", async () => {
    const s = session();
    await s.start({ model: "gemini-3.8-flash-low", reasoningLevel: "high" });
    const [argv] = s.argvLog();
    expect(flagValue(argv, "--model")).toBe("gemini-3.8-flash-low");
    expect(argv).not.toContain("--effort");
  });

  it("drops an effort the model does not offer once the catalog is known", async () => {
    const s = session();
    await s.ok("model/list", {});
    await s.start({ model: "gpt-oss-120b", reasoningLevel: "high" });
    expect(s.argvLog()[0]).not.toContain("--effort");
  });

  it("maps permission modes and plan mode, restarting agy on the same conversation", async () => {
    const s = session();
    const providerThreadId = await s.start({ ...PERMISSION_OPTIONS.auto });
    expect(flagValue(s.argvLog()[0], "--mode")).toBe("auto");

    await s.turn(providerThreadId, "plan it", creq(4), {
      ...PERMISSION_OPTIONS.auto,
      promptMode: "plan",
    });
    await s.waitForTurns(1);
    await s.turn(providerThreadId, "now do it", creq(5), {
      ...PERMISSION_OPTIONS["accept-edits"],
    });
    await s.waitForTurns(2);

    const [, planArgv, editArgv] = s.argvLog();
    expect(flagValue(planArgv, "--mode")).toBe("plan");
    expect(flagValue(planArgv, "--conversation")).toBe(providerThreadId);
    expect(flagValue(editArgv, "--mode")).toBe("accept-edits");
    expect(flagValue(editArgv, "--conversation")).toBe(providerThreadId);
    expect(s.argvLog()).toHaveLength(3);
  });

  it("reuses the running agy while the flags stay the same", async () => {
    const s = session();
    const providerThreadId = await s.start();
    await s.turn(providerThreadId, "one", creq(6));
    await s.waitForTurns(1);
    await s.turn(providerThreadId, "two", creq(7));
    await s.waitForTurns(2);
    expect(s.argvLog()).toHaveLength(1);
  });
});

describe("queueing and interruption", () => {
  it("runs a message steered mid-turn after the running turn, in order", async () => {
    const s = session();
    const providerThreadId = await s.start();
    await s.turn(providerThreadId, "slow first", creq(8));
    await s.waitFor(
      (events) => events.some((e) => e.type === "item/agentMessage/delta"),
      "the first delta",
    );
    await s.ok("turn/steer", {
      threadId: s.threadId,
      providerThreadId,
      expectedTurnId: "turn-1",
      clientRequestId: creq(9),
      input: textInput("second"),
      options: BASE_OPTIONS,
    });
    await s.waitForTurns(2);

    expect(turnStatuses(s.pump())).toEqual(["completed", "completed"]);
    const accepted = s
      .pump()
      .flatMap((e) =>
        e.type === "turn/input/accepted" ? [e.clientRequestId] : [],
      );
    expect(accepted).toEqual([creq(8), creq(9)]);
    expect(s.prompts()).toEqual(["slow first", "second"]);
  });

  it("rejects steering when no turn is running", async () => {
    const s = session();
    const providerThreadId = await s.start();
    const response = await s.request("turn/steer", {
      threadId: s.threadId,
      providerThreadId,
      expectedTurnId: "turn-1",
      clientRequestId: creq(10),
      input: textInput("too late"),
      options: BASE_OPTIONS,
    });
    expect(response.error).toMatchObject({
      code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
    });
  });

  it("interrupts the running turn and settles queued messages, then carries on", async () => {
    const s = session();
    const providerThreadId = await s.start();
    await s.turn(providerThreadId, "slow first", creq(11));
    await s.waitFor(
      (events) => events.some((e) => e.type === "item/agentMessage/delta"),
      "the first delta",
    );
    await s.ok("turn/steer", {
      threadId: s.threadId,
      providerThreadId,
      expectedTurnId: "turn-1",
      clientRequestId: creq(12),
      input: textInput("queued"),
      options: BASE_OPTIONS,
    });
    await s.ok("thread/stop", {
      threadId: s.threadId,
      providerThreadId,
      activeTurnId: null,
      intent: "interrupt",
    });
    await s.waitForTurns(2);
    expect(turnStatuses(s.pump())).toEqual(["interrupted", "interrupted"]);
    expect(s.prompts()).toEqual(["slow first"]);

    await s.turn(providerThreadId, "after", creq(13));
    await s.waitForTurns(3);
    expect(turnStatuses(s.pump()).at(-1)).toBe("completed");
    expect(flagValue(s.argvLog().at(-1), "--conversation")).toBe(
      providerThreadId,
    );
  });

  it("fabricates nothing on release", async () => {
    const s = session();
    const providerThreadId = await s.start();
    const before = s.pump().length;
    await s.ok("thread/stop", {
      threadId: s.threadId,
      providerThreadId,
      activeTurnId: null,
      intent: "release",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.pump()).toHaveLength(before);
  });
});

describe("Cloudroom instructions", () => {
  const INSTRUCTIONS = "Use room-cli for Cloudroom tasks.";

  it("sends them once, ahead of the first message of a new conversation", async () => {
    const s = session();
    const providerThreadId = await s.start({ instructions: INSTRUCTIONS });
    await s.turn(providerThreadId, "first", creq(14));
    await s.waitForTurns(1);
    await s.turn(providerThreadId, "second", creq(15));
    await s.waitForTurns(2);

    const [first, second] = s.prompts();
    expect(first).toContain("<cloudroom-instructions>");
    expect(first).toContain(INSTRUCTIONS);
    expect(first?.endsWith("User request:\nfirst")).toBe(true);
    expect(second).toBe("second");
  });

  it("does not resend unchanged instructions on resume, but resends changed ones", async () => {
    const s = session();
    const providerThreadId = await s.start({ instructions: INSTRUCTIONS });
    await s.turn(providerThreadId, "first", creq(16));
    await s.waitForTurns(1);

    await s.ok("thread/resume", {
      threadId: s.threadId,
      providerThreadId,
      cwd: s.cwd,
      instructionMode: "append",
      options: { ...BASE_OPTIONS, instructions: INSTRUCTIONS },
    });
    await s.turn(providerThreadId, "after resume", creq(17));
    await s.waitForTurns(2);
    expect(s.prompts()[1]).toBe("after resume");

    await s.ok("thread/resume", {
      threadId: s.threadId,
      providerThreadId,
      cwd: s.cwd,
      instructionMode: "append",
      options: { ...BASE_OPTIONS, instructions: "Prefer English." },
    });
    await s.turn(providerThreadId, "after change", creq(18));
    await s.waitForTurns(3);
    const changed = s.prompts()[2];
    expect(changed).toContain(
      "replace any earlier <cloudroom-instructions> block",
    );
    expect(changed).toContain("Prefer English.");
  });
});

describe("maintenance", () => {
  it("reports health with the installed agy version", async () => {
    const s = session();
    const result = await s.ok("provider/health", { providerId: "agy" });
    expect(result).toMatchObject({
      supported: true,
      health: { status: "ready", installedVersion: "9.9.9" },
    });
  });

  it("lists base models with their efforts from agy models", async () => {
    const s = session();
    const result = await s.ok("model/list", {});
    const models = result.models as Array<{
      id: string;
      supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
    }>;
    expect(models.map((model) => model.id)).toEqual([
      "gemini-4-argon",
      "gemini-3.8-flash",
      "gpt-oss-120b",
    ]);
    expect(
      models[2]?.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    ).toEqual(["medium"]);
  });
});
