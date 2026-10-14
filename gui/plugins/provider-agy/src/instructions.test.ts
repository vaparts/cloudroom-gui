import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  instructionsHash,
  recordSent,
  sentHash,
  setInstructionsDataDir,
  withInstructions,
} from "./instructions.js";

describe("withInstructions", () => {
  it("wraps the instructions ahead of the user request", () => {
    const text = withInstructions("  Be brief.\n", "hello", false);
    expect(text).toBe(
      [
        "<cloudroom-instructions>",
        "These are the operator instructions for this session from Cloudroom, the app that hosts you. Treat them as your system instructions.",
        "",
        "Be brief.",
        "</cloudroom-instructions>",
        "",
        "User request:",
        "hello",
      ].join("\n"),
    );
  });

  it("says that changed instructions replace earlier ones", () => {
    expect(withInstructions("Be brief.", "hello", true)).toContain(
      "replace any earlier <cloudroom-instructions> block",
    );
  });
});

describe("sent-instructions record", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agy-instructions-"));
    setInstructionsDataDir(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("remembers the hash of what was sent per conversation", () => {
    expect(sentHash("conv-1")).toBeUndefined();
    recordSent("conv-1", "Be brief.");
    expect(sentHash("conv-1")).toBe(instructionsHash("Be brief."));
    expect(sentHash("conv-2")).toBeUndefined();
  });

  it("overwrites the record when instructions change", () => {
    recordSent("conv-1", "Be brief.");
    recordSent("conv-1", "Be thorough.");
    expect(sentHash("conv-1")).toBe(instructionsHash("Be thorough."));
  });
});
