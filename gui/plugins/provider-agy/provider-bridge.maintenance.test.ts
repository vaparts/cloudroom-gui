import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AGY_INSTALL_SCRIPT_URL,
  AGY_UPDATE_MANIFEST_ENV,
  parseAgyUsage,
} from "./src/maintenance.js";
import { AGY_EXECUTABLE_ENV } from "./src/vocabulary.js";
import { BridgeSession, FAKE_AGY } from "./test/harness.js";

const saved = {
  executable: process.env[AGY_EXECUTABLE_ENV],
  manifest: process.env[AGY_UPDATE_MANIFEST_ENV],
  home: process.env.HOME,
  path: process.env.PATH,
};
const servers: Server[] = [];
let session: BridgeSession;

async function manifestServer(status: number, body: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return `http://127.0.0.1:${address.port}/manifests/linux_amd64.json`;
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(() => {
  process.env[AGY_EXECUTABLE_ENV] = FAKE_AGY;
  session = new BridgeSession("thr_agy_maintenance");
});

afterEach(() => {
  process.env[AGY_EXECUTABLE_ENV] = FAKE_AGY;
  restore("HOME", saved.home);
  restore("PATH", saved.path);
});

afterAll(async () => {
  session.dispose();
  restore(AGY_EXECUTABLE_ENV, saved.executable);
  restore(AGY_UPDATE_MANIFEST_ENV, saved.manifest);
  await Promise.all(
    servers.map(
      (server) => new Promise((resolve) => server.close(() => resolve(null))),
    ),
  );
});

const status = () =>
  session.ok("provider/installation/status", { providerId: "agy" });
const run = (action: "install" | "update") =>
  session.ok("provider/installation/run", { providerId: "agy", action });

describe("installation status", () => {
  it("offers agy update when Google's manifest is newer", async () => {
    process.env[AGY_UPDATE_MANIFEST_ENV] = await manifestServer(200, {
      version: "10.0.0",
    });
    expect(await status()).toMatchObject({
      executableName: "agy",
      executablePath: FAKE_AGY,
      installed: true,
      installSource: "external",
      currentVersion: "9.9.9",
      latestVersion: "10.0.0",
      needsUpdate: true,
      installAction: { kind: "update", label: "Update" },
    });
    expect(await run("update")).toEqual({
      available: true,
      command: {
        command: FAKE_AGY,
        args: ["update"],
        displayCommand: expect.stringContaining("update"),
      },
      verification: { kind: "version_at_least", version: "10.0.0" },
    });
  });

  it("offers nothing when agy is current, and refuses a stale update", async () => {
    process.env[AGY_UPDATE_MANIFEST_ENV] = await manifestServer(200, {
      version: "9.9.9",
    });
    expect(await status()).toMatchObject({
      latestVersion: "9.9.9",
      needsUpdate: false,
      installAction: null,
    });
    expect(await run("update")).toMatchObject({ available: false });
  });

  it("keeps working when the manifest is unreachable", async () => {
    process.env[AGY_UPDATE_MANIFEST_ENV] = await manifestServer(500, {});
    expect(await status()).toMatchObject({
      installed: true,
      currentVersion: "9.9.9",
      latestVersion: null,
      needsUpdate: false,
      installAction: null,
    });
  });

  it("offers Google's installer when agy is missing", async () => {
    process.env[AGY_UPDATE_MANIFEST_ENV] = await manifestServer(200, {
      version: "10.0.0",
    });
    delete process.env[AGY_EXECUTABLE_ENV];
    const emptyHome = mkdtempSync(join(tmpdir(), "agy-no-home-"));
    process.env.HOME = emptyHome;
    process.env.PATH = emptyHome;
    try {
      expect(await status()).toMatchObject({
        installed: false,
        installSource: "notInstalled",
        executablePath: null,
        currentVersion: null,
        installAction: {
          kind: "install",
          label: "Install",
          command: expect.stringContaining(AGY_INSTALL_SCRIPT_URL),
        },
      });
      expect(await run("install")).toMatchObject({
        available: true,
        verification: { kind: "installed" },
      });
      expect(await run("update")).toMatchObject({ available: false });
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("usage", () => {
  it("parses agy /usage into used-percent windows", () => {
    const windows = parseAgyUsage(
      [
        "Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-25T09:41:37Z",
        "Gemini Models\tFive Hour Limit Remaining\t99%\t2026-10-18T23:22:40Z",
        "Claude and GPT models\tFive Hour Limit Remaining\t40%\tnot-a-date",
        "garbage line",
        "",
      ].join("\n"),
    );
    expect(windows).toEqual([
      {
        label: "Gemini Models (weekly)",
        kind: "weekly",
        model: "Gemini Models",
        usedPercent: 0,
        resetsAt: "2026-10-25T09:41:37.000Z",
      },
      {
        label: "Gemini Models (5-hour)",
        kind: "five-hour",
        model: "Gemini Models",
        usedPercent: 1,
        resetsAt: "2026-10-18T23:22:40.000Z",
      },
      {
        label: "Claude and GPT models (5-hour)",
        kind: "five-hour",
        model: "Claude and GPT models",
        usedPercent: 60,
        resetsAt: null,
      },
    ]);
  });

  it("answers provider/usage from agy /usage", async () => {
    const result = await session.ok("provider/usage", { providerId: "agy" });
    expect(result).toMatchObject({
      supported: true,
      usage: { status: "ok", accountEmail: null, planLabel: null },
    });
    const windows = (
      result.usage as { windows: Array<{ label: string; usedPercent: number }> }
    ).windows;
    expect(windows.map((window) => [window.label, window.usedPercent])).toEqual(
      [
        ["Gemini Models (weekly)", 0],
        ["Gemini Models (5-hour)", 1],
        ["Claude and GPT models (weekly)", 0],
        ["Claude and GPT models (5-hour)", 60],
      ],
    );
  });
});
