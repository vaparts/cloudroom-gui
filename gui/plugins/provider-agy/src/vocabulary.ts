import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";

export const AGY_PROVIDER_ID = "agy";

export const AGY_EXECUTABLE_ENV = "BB_AGY_EXECUTABLE";

export const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgyEffort = (typeof AGY_EFFORTS)[number];

export const AGY_EFFORT_LABELS: Record<AgyEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function isAgyEffort(value: unknown): value is AgyEffort {
  return (
    typeof value === "string" &&
    (AGY_EFFORTS as readonly string[]).includes(value)
  );
}

const EFFORT_SUFFIX = new RegExp(`-(${AGY_EFFORTS.join("|")})$`);
const EFFORT_LABEL_SUFFIX = / \((Low|Medium|High|Extra High|Max)\)$/;

export const AGY_DEFAULT_MODEL_ID = "gemini-3.8-flash";

export function agyModel(
  id: string,
  displayName: string,
  efforts: readonly AgyEffort[],
  isDefault: boolean,
): PluginProviderFallbackModel {
  const levels: readonly AgyEffort[] =
    efforts.length > 0 ? efforts : ["medium"];
  return {
    id,
    displayName,
    description: `${displayName} via Antigravity CLI`,
    supportedReasoningEfforts: levels.map((effort) => ({
      reasoningEffort: effort,
      description: AGY_EFFORT_LABELS[effort],
    })),
    defaultReasoningEffort: levels.includes("medium")
      ? "medium"
      : (levels[0] as AgyEffort),
    isDefault,
  };
}

export interface AgyCatalogEntry {
  id: string;
  displayName: string;
  efforts: AgyEffort[];
}

export function parseAgyModels(stdout: string): AgyCatalogEntry[] {
  const byBase = new Map<string, AgyCatalogEntry>();
  for (const line of stdout.split("\n")) {
    const [rawId, rawName] = line.split("\t");
    const id = rawId?.trim() ?? "";
    if (rawName === undefined || !/^[\w.-]+$/.test(id)) continue;
    const match = EFFORT_SUFFIX.exec(id);
    const base = match ? id.slice(0, -match[0].length) : id;
    const entry = byBase.get(base) ?? {
      id: base,
      displayName: rawName.trim().replace(EFFORT_LABEL_SUFFIX, ""),
      efforts: [],
    };
    const effort = match?.[1];
    if (isAgyEffort(effort) && !entry.efforts.includes(effort))
      entry.efforts.push(effort);
    byBase.set(base, entry);
  }
  for (const entry of byBase.values()) {
    entry.efforts.sort(
      (a, b) => AGY_EFFORTS.indexOf(a) - AGY_EFFORTS.indexOf(b),
    );
  }
  return [...byBase.values()];
}

export const AGY_FALLBACK_CATALOG: AgyCatalogEntry[] = [
  {
    id: AGY_DEFAULT_MODEL_ID,
    displayName: "Gemini 3.8 Flash",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-4-argon",
    displayName: "Gemini 4 Argon",
    efforts: ["low", "medium", "high"],
  },
];

export function catalogToModels(
  catalog: readonly AgyCatalogEntry[],
): PluginProviderFallbackModel[] {
  const hasDefault = catalog.some((entry) => entry.id === AGY_DEFAULT_MODEL_ID);
  return catalog.map((entry, index) =>
    agyModel(
      entry.id,
      entry.displayName,
      entry.efforts,
      hasDefault ? entry.id === AGY_DEFAULT_MODEL_ID : index === 0,
    ),
  );
}

export const AGY_FALLBACK_MODELS = catalogToModels(AGY_FALLBACK_CATALOG);
