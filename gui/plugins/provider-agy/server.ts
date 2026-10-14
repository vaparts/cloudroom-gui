import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AGY_EFFORTS,
  AGY_EFFORT_LABELS,
  AGY_EXECUTABLE_ENV,
  AGY_FALLBACK_MODELS,
  AGY_PROVIDER_ID,
} from "./src/vocabulary.js";

export default function plugin(bb: BbPluginApi) {
  bb.providers.register({
    id: AGY_PROVIDER_ID,
    displayName: "Antigravity",
    icon: "Zap",
    family: "google",
    strings: {
      signInHint:
        "Run `agy` once in a terminal on this machine and sign in with your Google account.",
      expiredHint:
        "Your Antigravity session expired. Run `agy` in a terminal to sign in again, then retry.",
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      planModeCopy:
        "Antigravity will plan without making changes (agy --mode plan).",
    },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: [...AGY_EFFORTS],
    },
    reasoningLevels: AGY_EFFORTS.map((id) => ({
      id,
      label: AGY_EFFORT_LABELS[id],
    })),
    composerActions: ["plan"],
    models: { fallback: AGY_FALLBACK_MODELS, scope: "host" },
    env: { passthrough: [AGY_EXECUTABLE_ENV] },
  });
}
