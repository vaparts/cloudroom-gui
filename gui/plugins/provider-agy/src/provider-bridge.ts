import {
  type ClientTurnRequestId,
  type DeltaPresentation,
  type PromptInput,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  createBridgeIo,
  experimental_defineProviderBridge,
  experimental_presentationTitle as presentationTitle,
  experimental_withTitle as withTitle,
  initializeParamsSchema,
  modelListParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { childEnv, findAgy, runAgy } from "./agy-cli.js";
import {
  instructionsHash,
  recordSent,
  sentHash,
  setInstructionsDataDir,
  withInstructions,
} from "./instructions.js";
import {
  agyHealth,
  agyInstallationRun,
  agyInstallationStatus,
  agyUsage,
} from "./maintenance.js";
import {
  AGY_DEFAULT_MODEL_ID,
  AGY_FALLBACK_CATALOG,
  type AgyCatalogEntry,
  type AgyEffort,
  catalogToModels,
  isAgyEffort,
  parseAgyModels,
} from "./vocabulary.js";

type JsonRpcId = string | number;
type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const io = createBridgeIo<OutboundMessage>();

const INIT_TIMEOUT_MS = 30_000;

interface LaunchSettings {
  model: string;
  effort: AgyEffort | null;
  permissionMode: string;
  plan: boolean;
}

function sameSettings(a: LaunchSettings, b: LaunchSettings): boolean {
  return (
    a.model === b.model &&
    a.effort === b.effort &&
    a.permissionMode === b.permissionMode &&
    a.plan === b.plan
  );
}

function agyArgs(
  settings: LaunchSettings,
  conversation: string | null,
): string[] {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    settings.model,
  ];
  if (settings.effort !== null) args.push("--effort", settings.effort);
  if (conversation !== null) args.push("--conversation", conversation);
  if (settings.plan) {
    args.push("--mode", "plan");
  } else if (settings.permissionMode === "full") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push(
      "--mode",
      settings.permissionMode === "auto" ? "auto" : "accept-edits",
    );
  }
  args.push("-p=");
  return args;
}

interface OpenItem {
  key: { providerItemId: string };
  text: string;
  name: string;
  args: unknown;
}

interface Turn {
  ordinal: number;
  messages: Map<number, OpenItem>;
  tools: Map<number, OpenItem>;
}

interface Session {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  settings: LaunchSettings;
  envVars: Record<string, string> | undefined;
  child: ChildProcessWithoutNullStreams | null;
  stderrTail: string[];
  turn: Turn | null;
  turnCounter: number;
  pending: Array<{
    text: string;
    clientRequestId: ClientTurnRequestId;
    settings: LaunchSettings;
  }>;
  usageTotal: ThreadEventTokenUsageBreakdown;
  releasing: boolean;
  pendingInstructions: { text: string; updated: boolean } | null;
}

const sessions = new Map<string, Session>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emit(session: Session, deltas: ThreadDelta[]): void {
  if (deltas.length === 0) return;
  notify(THREAD_DELTA_NOTIFICATION_METHOD, {
    threadId: session.threadId,
    deltas,
  });
}

function promptText(input: readonly PromptInput[]): string {
  return input
    .filter(
      (item): item is Extract<PromptInput, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("");
}

const MESSAGE_PRESENTATION: DeltaPresentation = {
  label: { pending: "Responding", completed: "Responded" },
  icon: { glyph: "Zap" },
};

function toolPresentation(name: string, args: unknown): DeltaPresentation {
  const glyph = /command|shell|terminal/i.test(name)
    ? "Terminal"
    : /file|read|view/i.test(name)
      ? "FileText"
      : /search|grep|find/i.test(name)
        ? "Search"
        : "Toolbox";
  const detail = summarizeArgs(args);
  const base: DeltaPresentation = {
    label: { pending: `Running ${name}`, completed: `Ran ${name}` },
    icon: { glyph },
  };
  return detail === "" ? base : withTitle(base, presentationTitle(detail));
}

function summarizeArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const values = Object.values(args as Record<string, unknown>).filter(
    (value): value is string => typeof value === "string",
  );
  return (values[0] ?? "").slice(0, 160);
}

function itemKey(session: Session, turn: Turn, step: number, suffix: string) {
  return {
    providerItemId: `agy-${session.providerThreadId}-t${turn.ordinal}-s${step}-${suffix}`,
  };
}

function usageFrom(raw: unknown): ThreadEventTokenUsageBreakdown {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const num = (key: string) =>
    typeof usage[key] === "number" ? (usage[key] as number) : 0;
  return {
    ...ZERO_TOKEN_USAGE,
    inputTokens: num("input_tokens"),
    cachedInputTokens: num("cache_read_tokens"),
    outputTokens: num("output_tokens"),
    reasoningOutputTokens: num("thinking_tokens"),
    totalTokens: num("total_tokens"),
  };
}

function settleTurn(
  session: Session,
  status: "completed" | "failed" | "interrupted",
  extra: ThreadDelta[] = [],
): void {
  const turn = session.turn;
  if (turn === null) return;
  const deltas: ThreadDelta[] = [];
  for (const message of turn.messages.values()) {
    deltas.push({
      kind: "item.textClose",
      key: message.key,
      channel: "agentMessage",
      text: message.text,
    });
  }
  for (const tool of turn.tools.values()) {
    deltas.push({
      kind: "item.close",
      key: tool.key,
      status: "failed",
      item: {
        type: "tool",
        tool: tool.name,
        args: tool.args,
        error: "turn ended",
      },
      presentation: toolPresentation(tool.name, tool.args),
    } as ThreadDelta);
  }
  deltas.push(...extra, { kind: "turn.boundary", status });
  session.turn = null;
  emit(session, deltas);
  if (status === "interrupted") {
    const abandoned = session.pending;
    session.pending = [];
    for (const queued of abandoned) {
      emit(session, [
        { kind: "input.accepted", clientRequestId: queued.clientRequestId },
        { kind: "turn.open" },
        { kind: "turn.boundary", status: "interrupted" },
      ]);
    }
    return;
  }
  const next = session.pending.shift();
  if (next !== undefined) void runQueued(session, next);
}

function onAgyEvent(session: Session, event: Record<string, unknown>): void {
  const turn = session.turn;
  if (event.event === "step_update" && turn !== null) {
    const step = (event.step_update ?? {}) as Record<string, unknown>;
    const index = typeof step.step_index === "number" ? step.step_index : -1;
    const state = step.state;
    const type = step.step_type;
    const textDelta =
      typeof step.text_delta === "string" ? step.text_delta : "";
    const deltas: ThreadDelta[] = [];

    if (type === "agent_response") {
      let message = turn.messages.get(index);
      if (message === undefined && textDelta !== "") {
        message = {
          key: itemKey(session, turn, index, "msg"),
          text: "",
          name: "",
          args: null,
        };
        turn.messages.set(index, message);
        deltas.push({
          kind: "item.open",
          key: message.key,
          item: { type: "agentMessage", text: "" },
          presentation: MESSAGE_PRESENTATION,
        });
      }
      if (message !== undefined && textDelta !== "") {
        message.text += textDelta;
        deltas.push({
          kind: "item.textDelta",
          key: message.key,
          channel: "agentMessage",
          text: textDelta,
        });
      }
      if (message !== undefined && state === "DONE") {
        deltas.push({
          kind: "item.textClose",
          key: message.key,
          channel: "agentMessage",
          text: message.text,
        });
        turn.messages.delete(index);
      }
    } else if (type === "tool") {
      const info = (step.tool_info ?? {}) as Record<string, unknown>;
      const name =
        (typeof info.name === "string" && info.name) ||
        (typeof step.tool_name === "string" && step.tool_name) ||
        "tool";
      const args = info.parameters ?? {};
      let tool = turn.tools.get(index);
      if (tool === undefined) {
        tool = {
          key: itemKey(session, turn, index, "tool"),
          text: "",
          name,
          args,
        };
        turn.tools.set(index, tool);
        deltas.push({
          kind: "item.open",
          key: tool.key,
          item: { type: "tool", tool: name, args },
          presentation: toolPresentation(name, args),
        } as ThreadDelta);
      }
      if (state === "DONE") {
        const error = info.error as { message?: unknown } | undefined;
        const failed = error !== undefined && error !== null;
        const output =
          typeof info.output === "string"
            ? info.output
            : info.output === undefined
              ? ""
              : JSON.stringify(info.output);
        deltas.push({
          kind: "item.close",
          key: tool.key,
          status: failed ? "failed" : "completed",
          item: failed
            ? {
                type: "tool",
                tool: name,
                args,
                error: String(error?.message ?? "tool failed"),
              }
            : { type: "tool", tool: name, args, result: output },
          presentation: toolPresentation(name, args),
        } as ThreadDelta);
        turn.tools.delete(index);
      }
    }
    emit(session, deltas);
    return;
  }

  if (event.event === "result" && turn !== null) {
    const result = (event.result ?? {}) as Record<string, unknown>;
    const last = usageFrom(result.usage);
    session.usageTotal = addTokenUsage(session.usageTotal, last);
    const extra: ThreadDelta[] = [
      {
        kind: "usage",
        total: session.usageTotal,
        last,
        modelContextWindow: null,
      },
    ];
    if (result.status === "SUCCESS") {
      settleTurn(session, "completed", extra);
      return;
    }
    const message =
      typeof result.error === "string"
        ? result.error
        : `agy finished with status ${String(result.status)}`;
    const key = itemKey(session, turn, 9999, "error");
    extra.push(
      {
        kind: "item.open",
        key,
        item: { type: "agentMessage", text: "" },
        presentation: MESSAGE_PRESENTATION,
      },
      {
        kind: "item.textClose",
        key,
        channel: "agentMessage",
        text: `agy error: ${message}`,
      },
    );
    settleTurn(session, "failed", extra);
  }
}

function spawnAgy(
  session: Session,
  conversation: string | null,
): Promise<string> {
  const executable = findAgy();
  if (executable === null) {
    return Promise.reject(
      new Error("agy is not installed (expected ~/.local/bin/agy or on PATH)"),
    );
  }
  const child = spawn(executable, agyArgs(session.settings, conversation), {
    cwd: session.cwd,
    env: childEnv(session.envVars),
    stdio: ["pipe", "pipe", "pipe"],
  });
  session.child = child;
  session.stderrTail = [];

  return new Promise<string>((resolve, reject) => {
    let initialized = false;
    const timer = setTimeout(() => {
      if (!initialized) {
        child.kill("SIGTERM");
        reject(
          new Error(
            `agy did not start within ${INIT_TIMEOUT_MS} ms: ${session.stderrTail.join(" | ")}`,
          ),
        );
      }
    }, INIT_TIMEOUT_MS);

    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.event === "init" && !initialized) {
        initialized = true;
        clearTimeout(timer);
        resolve(String(event.conversation_id ?? conversation ?? ""));
        return;
      }
      if (session.child === child) onAgyEvent(session, event);
    });

    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.includes("logging before google.Init")) return;
      session.stderrTail.push(line);
      if (session.stderrTail.length > 20) session.stderrTail.shift();
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!initialized) {
        reject(
          new Error(
            `agy exited before init (code ${code}, signal ${signal}): ${session.stderrTail.join(" | ")}`,
          ),
        );
        return;
      }
      if (session.child !== child) return;
      session.child = null;
      if (session.releasing) return;
      if (session.turn !== null) settleTurn(session, "failed");
    });
  });
}

function startTurn(
  session: Session,
  userText: string,
  clientRequestId: ClientTurnRequestId | undefined,
): void {
  let text = userText;
  const instructions = session.pendingInstructions;
  if (instructions !== null) {
    text = withInstructions(instructions.text, userText, instructions.updated);
    recordSent(session.providerThreadId, instructions.text);
    session.pendingInstructions = null;
  }
  session.turnCounter += 1;
  session.turn = {
    ordinal: session.turnCounter,
    messages: new Map(),
    tools: new Map(),
  };
  const deltas: ThreadDelta[] = [];
  if (clientRequestId !== undefined)
    deltas.push({ kind: "input.accepted", clientRequestId });
  deltas.push({ kind: "turn.open" });
  emit(session, deltas);
  const line = JSON.stringify({ event: "user", message: { content: text } });
  session.child?.stdin.write(`${line}\n`);
}

async function ensureChild(
  session: Session,
  settings: LaunchSettings,
): Promise<void> {
  if (session.child !== null && sameSettings(settings, session.settings))
    return;
  if (session.child !== null) {
    const old = session.child;
    session.child = null;
    old.stdin.end();
    old.kill("SIGTERM");
  }
  session.settings = settings;
  await spawnAgy(session, session.providerThreadId);
}

async function runQueued(
  session: Session,
  queued: {
    text: string;
    clientRequestId: ClientTurnRequestId;
    settings: LaunchSettings;
  },
): Promise<void> {
  try {
    await ensureChild(session, queued.settings);
    startTurn(session, queued.text, queued.clientRequestId);
  } catch (error) {
    session.turnCounter += 1;
    session.turn = {
      ordinal: session.turnCounter,
      messages: new Map(),
      tools: new Map(),
    };
    emit(session, [
      { kind: "input.accepted", clientRequestId: queued.clientRequestId },
      { kind: "turn.open" },
    ]);
    const key = itemKey(session, session.turn, 9999, "error");
    settleTurn(session, "failed", [
      {
        kind: "item.open",
        key,
        item: { type: "agentMessage", text: "" },
        presentation: MESSAGE_PRESENTATION,
      },
      {
        kind: "item.textClose",
        key,
        channel: "agentMessage",
        text: `agy error: ${(error as Error).message}`,
      },
    ]);
  }
}

type LaunchOptions = {
  model?: string;
  reasoningLevel?: string;
  permissionMode?: string;
  promptMode?: string;
};

let catalog: AgyCatalogEntry[] = AGY_FALLBACK_CATALOG;

const LEGACY_EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

function launchSettings(options: LaunchOptions): LaunchSettings {
  const model = options.model ?? AGY_DEFAULT_MODEL_ID;
  let effort: AgyEffort | null = null;
  if (
    !LEGACY_EFFORT_SUFFIX.test(model) &&
    isAgyEffort(options.reasoningLevel)
  ) {
    const supported = catalog.find((entry) => entry.id === model)?.efforts;
    if (
      supported === undefined ||
      supported.length === 0 ||
      supported.includes(options.reasoningLevel)
    ) {
      effort = options.reasoningLevel;
    }
  }
  return {
    model,
    effort,
    permissionMode: options.permissionMode ?? "accept-edits",
    plan: options.promptMode === "plan",
  };
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

async function listAgyModels() {
  const stdout = await runAgy(["models"], 30_000);
  const parsed = stdout === null ? [] : parseAgyModels(stdout);
  if (parsed.length > 0) catalog = parsed;
  return catalogToModels(catalog);
}

function newSession(args: {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  settings: LaunchSettings;
  envVars: Record<string, string> | undefined;
}): Session {
  return {
    ...args,
    child: null,
    stderrTail: [],
    turn: null,
    turnCounter: 0,
    pending: [],
    usageTotal: ZERO_TOKEN_USAGE,
    releasing: false,
    pendingInstructions: null,
  };
}

function announce(session: Session): void {
  sessions.set(session.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: session.threadId,
    providerThreadId: session.providerThreadId,
  });
  emit(session, [{ kind: "session.reset" }]);
}

type RequestHandler = (id: JsonRpcId, params: unknown) => Promise<void> | void;

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.initialize,
        parsed.error.issues,
      );
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "provider",
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: async (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.modelList,
        parsed.error.issues,
      );
    const models = await listAgyModels();
    io.sendResult(id, {
      models: models.map((model) => ({ ...model, model: model.id })),
      selectedOnlyModels: [],
    });
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: async (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerHealth,
        parsed.error.issues,
      );
    io.sendResult(id, await agyHealth());
  },

  [BRIDGE_REQUEST_METHODS.providerUsage]: async (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerUsage,
        parsed.error.issues,
      );
    io.sendResult(id, await agyUsage());
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationStatus]: async (id, params) => {
    const parsed = providerInstallationStatusParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerInstallationStatus,
        parsed.error.issues,
      );
    io.sendResult(id, await agyInstallationStatus());
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationRun]: async (id, params) => {
    const parsed = providerInstallationRunParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerInstallationRun,
        parsed.error.issues,
      );
    io.sendResult(id, await agyInstallationRun(parsed.data.action));
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: async (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadStart,
        parsed.error.issues,
      );
    const { threadId, cwd, options, input } = parsed.data;
    const session = newSession({
      threadId,
      providerThreadId: "",
      cwd,
      settings: launchSettings(options as LaunchOptions),
      envVars: options.envVars,
    });
    try {
      session.providerThreadId = await spawnAgy(session, null);
    } catch (error) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
        (error as Error).message,
      );
      return;
    }
    const instructions = options.instructions?.trim() ?? "";
    if (instructions !== "")
      session.pendingInstructions = { text: instructions, updated: false };
    announce(session);
    io.sendResult(id, {
      providerThreadId: session.providerThreadId,
      sessionRestorable: true,
    });
    if (input !== undefined && input.length > 0)
      startTurn(session, promptText(input), undefined);
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: async (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadResume,
        parsed.error.issues,
      );
    const { threadId, providerThreadId, cwd, options } = parsed.data;
    const session = newSession({
      threadId,
      providerThreadId,
      cwd,
      settings: launchSettings(options as LaunchOptions),
      envVars: options.envVars,
    });
    try {
      await spawnAgy(session, providerThreadId);
    } catch (error) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
        (error as Error).message,
      );
      return;
    }
    const instructions = options.instructions?.trim() ?? "";
    if (
      instructions !== "" &&
      sentHash(providerThreadId) !== instructionsHash(instructions)
    ) {
      session.pendingInstructions = { text: instructions, updated: true };
    }
    announce(session);
    io.sendResult(id, { providerThreadId, sessionRestorable: true });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: async (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.turnStart,
        parsed.error.issues,
      );
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    const text = promptText(parsed.data.input);
    const settings = launchSettings(parsed.data.options as LaunchOptions);
    if (session.turn !== null) {
      io.sendResult(id, {});
      session.pending.push({
        text,
        clientRequestId: parsed.data.clientRequestId,
        settings,
      });
      return;
    }
    try {
      await ensureChild(session, settings);
    } catch (error) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
        (error as Error).message,
      );
      return;
    }
    io.sendResult(id, {});
    startTurn(session, text, parsed.data.clientRequestId);
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.turnSteer,
        parsed.error.issues,
      );
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined || session.turn === null) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        `No active turn to steer (expected ${parsed.data.expectedTurnId})`,
      );
      return;
    }
    session.pending.push({
      text: promptText(parsed.data.input),
      clientRequestId: parsed.data.clientRequestId,
      settings: launchSettings(parsed.data.options as LaunchOptions),
    });
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success)
      return invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadStop,
        parsed.error.issues,
      );
    const session = sessions.get(parsed.data.threadId);
    if (session !== undefined) {
      const child = session.child;
      session.child = null;
      if (parsed.data.intent === "release") {
        session.releasing = true;
        sessions.delete(parsed.data.threadId);
      } else {
        settleTurn(session, "interrupted");
      }
      if (child !== null) {
        child.stdin.end();
        child.kill("SIGTERM");
      }
    }
    io.sendResult(id, {});
  },
};

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message))
    return;
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof method !== "string") return;
  if (typeof id !== "string" && typeof id !== "number") return;
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start({ dataDir }) {
    setInstructionsDataDir(dataDir);
  },
  onClose() {
    for (const session of sessions.values()) {
      session.releasing = true;
      session.child?.kill("SIGTERM");
    }
  },
});
