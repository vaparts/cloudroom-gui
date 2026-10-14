import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { CapturedBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./src/provider-bridge.js";
import { useFakeAgy } from "./test/harness.js";

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;
let restoreAgy: () => void;

beforeEach(() => {
  restoreAgy = useFakeAgy();
  workspaceDir = mkdtempSync(join(tmpdir(), "agy-conformance-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  restoreAgy();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("passes the canonical provider bridge protocol suite", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: output.takeMessages },
    providerId: "agy",
    session: {
      cwd: workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      interruptiblePromptInput: [
        { type: "text", text: "slow story", mentions: [] },
      ],
    },
    timeoutMs: 10_000,
  });
  output.restore();
  console.info(`agy bridge conformance:\n${formatConformanceReport(report)}`);

  const statusById = Object.fromEntries(
    report.results.map((result) => [result.id, result.status]),
  );
  expect(statusById).toEqual({
    "rpc/unknown-method": "pass",
    "rpc/invalid-params": "pass",
    "rpc/non-json-ignored": "pass",
    "rpc/response-not-request": "pass",
    "handshake/initialize": "pass",
    "skills/configure-declared": "pass",
    "session/start-identity": "pass",
    "turn/lifecycle": "pass",
    "events/schema-valid": "pass",
    "item/opens-before-delta": "pass",
    "stop/release-not-interrupted": "pass",
    "session/resume-identity": "pass",
    "session/resume-id-uniqueness": "pass",
    "session/threads-independent": "pass",
    "stop/interrupt-settles-before-result": "pass",
  });
  expect(report.passed).toBe(true);
}, 60_000);
