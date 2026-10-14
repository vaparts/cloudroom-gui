import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_FILE = "instructions-state.json";
const MAX_ENTRIES = 500;

let dataDir: string | null = null;

export function setInstructionsDataDir(dir: string): void {
  dataDir = dir;
}

export function instructionsHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readState(): Record<string, string> {
  if (dataDir === null) return {};
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dataDir, STATE_FILE), "utf8"),
    );
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function sentHash(conversationId: string): string | undefined {
  return readState()[conversationId];
}

export function recordSent(conversationId: string, text: string): void {
  if (dataDir === null) return;
  const state = readState();
  delete state[conversationId];
  state[conversationId] = instructionsHash(text);
  const keys = Object.keys(state);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)))
    delete state[key];
  try {
    writeFileSync(join(dataDir, STATE_FILE), `${JSON.stringify(state)}\n`);
  } catch {}
}

export function withInstructions(
  instructions: string,
  userText: string,
  updated: boolean,
): string {
  const lead = updated
    ? "The operator instructions for this session changed. They replace any earlier <cloudroom-instructions> block in this conversation."
    : "These are the operator instructions for this session from Cloudroom, the app that hosts you. Treat them as your system instructions.";
  return [
    "<cloudroom-instructions>",
    lead,
    "",
    instructions.trim(),
    "</cloudroom-instructions>",
    "",
    "User request:",
    userText,
  ].join("\n");
}
