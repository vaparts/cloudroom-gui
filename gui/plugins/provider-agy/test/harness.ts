import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeDeltaEventCollector,
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
  BridgeJsonRpcTestHarness,
  ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "../src/provider-bridge.js";
import { AGY_EXECUTABLE_ENV, AGY_PROVIDER_ID } from "../src/vocabulary.js";

export const FAKE_AGY = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-agy.mjs",
);

export const BASE_OPTIONS = {
  model: "gemini-3.8-flash",
  reasoningLevel: "medium",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

export function useFakeAgy(): () => void {
  const saved = process.env[AGY_EXECUTABLE_ENV];
  process.env[AGY_EXECUTABLE_ENV] = FAKE_AGY;
  return () => {
    if (saved === undefined) delete process.env[AGY_EXECUTABLE_ENV];
    else process.env[AGY_EXECUTABLE_ENV] = saved;
  };
}

export function textInput(text: string): BridgeJsonRpcObject[] {
  return [{ type: "text", text, mentions: [] }];
}

let requestCounter = 0;

export class BridgeSession {
  readonly harness: BridgeJsonRpcTestHarness =
    createBridgeJsonRpcTestHarness(handleLine);
  readonly collector: BridgeDeltaEventCollector =
    createBridgeDeltaEventCollector(AGY_PROVIDER_ID);
  readonly cwd = mkdtempSync(join(tmpdir(), "agy-bridge-test-"));
  readonly events: ThreadEvent[] = [];
  private assembled = 0;

  constructor(readonly threadId: string) {}

  dispose(): void {
    this.harness.restore();
    rmSync(this.cwd, { recursive: true, force: true });
  }

  async request(
    method: string,
    params: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage> {
    requestCounter += 1;
    const id = `agy-test-${requestCounter}`;
    this.harness.sendRequest(id, method, params);
    return this.harness.waitForResponse(id);
  }

  async ok(
    method: string,
    params: BridgeJsonRpcObject,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(method, params);
    expect(
      response.error,
      `${method} answered an error: ${JSON.stringify(response.error)}`,
    ).toBeUndefined();
    return (response.result ?? {}) as Record<string, unknown>;
  }

  pump(): ThreadEvent[] {
    const messages = this.harness.messages;
    for (; this.assembled < messages.length; this.assembled += 1) {
      const message = messages[this.assembled];
      if (message !== undefined)
        this.events.push(...this.collector.assembleMessage(message));
    }
    return this.events;
  }

  async waitFor(
    predicate: (events: ThreadEvent[]) => boolean,
    what: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(this.pump())) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `timed out waiting for ${what}; saw ${this.pump()
        .map((event) => event.type)
        .join(", ")}`,
    );
  }

  count(type: ThreadEvent["type"]): number {
    return this.pump().filter((event) => event.type === type).length;
  }

  async waitForTurns(completed: number): Promise<void> {
    await this.waitFor(
      (events) =>
        events.filter((e) => e.type === "turn/completed").length >= completed,
      `${completed} completed turn(s)`,
    );
  }

  async start(
    options: BridgeJsonRpcObject = {},
    extra: BridgeJsonRpcObject = {},
  ): Promise<string> {
    const result = await this.ok("thread/start", {
      threadId: this.threadId,
      cwd: this.cwd,
      instructionMode: "append",
      options: { ...BASE_OPTIONS, ...options },
      ...extra,
    });
    return String(result.providerThreadId);
  }

  async turn(
    providerThreadId: string,
    text: string,
    clientRequestId: string,
    options: BridgeJsonRpcObject = {},
  ) {
    return this.ok("turn/start", {
      threadId: this.threadId,
      providerThreadId,
      input: textInput(text),
      clientRequestId,
      options: { ...BASE_OPTIONS, ...options },
    });
  }

  argvLog(): string[][] {
    return readLines(join(this.cwd, ".fake-agy", "argv.ndjson")) as string[][];
  }

  prompts(): string[] {
    return readLines(join(this.cwd, ".fake-agy", "prompts.ndjson")) as string[];
  }
}

function readLines(path: string): unknown[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

const CREQ_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export function creq(n: number): string {
  let id = "";
  let value = n;
  for (let i = 0; i < 10; i += 1) {
    id = (CREQ_ALPHABET[value % 32] as string) + id;
    value = Math.floor(value / 32);
  }
  return `creq_${id}`;
}

export const PERMISSION_OPTIONS = {
  full: {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  },
  auto: {
    permissionMode: "auto",
    permissionScope: "workspace",
    approvalReviewer: "automatic",
    permissionEscalation: "deny",
  },
  "accept-edits": {
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: "ask",
  },
} as const;
