import { describe, expect, it } from "vitest";
import {
  AGY_DEFAULT_MODEL_ID,
  catalogToModels,
  parseAgyModels,
} from "./vocabulary.js";

const AGY_MODELS_OUTPUT = [
  "Fetching available models...",
  "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
  "gemini-4-argon-high\tGemini 4 Argon (High)",
  "gemini-4-argon-low\tGemini 4 Argon (Low)",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");

describe("parseAgyModels", () => {
  it("groups effort-suffixed ids into base models with ordered efforts", () => {
    expect(parseAgyModels(AGY_MODELS_OUTPUT)).toEqual([
      {
        id: "gemini-4-argon",
        displayName: "Gemini 4 Argon",
        efforts: ["low", "medium", "high"],
      },
      {
        id: "gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        efforts: ["low", "medium", "high"],
      },
      { id: "gpt-oss-120b", displayName: "GPT-OSS 120B", efforts: ["medium"] },
    ]);
  });

  it("keeps an id without an effort suffix as its own model", () => {
    expect(parseAgyModels("plain-model\tPlain Model\n")).toEqual([
      { id: "plain-model", displayName: "Plain Model", efforts: [] },
    ]);
  });

  it("returns nothing for output without model lines", () => {
    expect(parseAgyModels("Fetching available models...\n")).toEqual([]);
  });
});

describe("catalogToModels", () => {
  const models = catalogToModels(parseAgyModels(AGY_MODELS_OUTPUT));

  it("marks exactly the default model", () => {
    expect(
      models.filter((model) => model.isDefault).map((model) => model.id),
    ).toEqual([AGY_DEFAULT_MODEL_ID]);
  });

  it("declares each model's own efforts and defaults to medium", () => {
    const oss = models.find((model) => model.id === "gpt-oss-120b");
    expect(
      oss?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    ).toEqual(["medium"]);
    expect(
      models.every((model) => model.defaultReasoningEffort === "medium"),
    ).toBe(true);
  });

  it("gives every model a non-blank description (the server rejects blank ones)", () => {
    for (const model of models) expect(model.description.trim()).not.toBe("");
  });
});
