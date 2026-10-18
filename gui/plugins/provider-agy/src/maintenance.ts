import {
  type ProviderHealthResult,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  experimental_clampPercent as clampPercent,
  experimental_compareVersions as compareVersions,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { findAgy, runAgy } from "./agy-cli.js";

export const AGY_INSTALL_SCRIPT_URL =
  "https://antigravity.google/cli/install.sh";

export const AGY_UPDATE_MANIFEST_ENV = "BB_AGY_UPDATE_MANIFEST_URL";

const MANIFEST_BASE_URL =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const LATEST_TTL_MS = 60 * 60_000;

const manifestSchema = z.object({ version: z.string() });

const latestCache = new Map<string, { version: string | null; at: number }>();

function manifestUrl(): string | null {
  const override = process.env[AGY_UPDATE_MANIFEST_ENV];
  if (override) return override;
  const os =
    process.platform === "linux"
      ? "linux"
      : process.platform === "darwin"
        ? "darwin"
        : null;
  const arch =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
        ? "arm64"
        : null;
  return os === null || arch === null
    ? null
    : `${MANIFEST_BASE_URL}/${os}_${arch}.json`;
}

async function latestAgyVersion(): Promise<string | null> {
  const url = manifestUrl();
  if (url === null) return null;
  const cached = latestCache.get(url);
  if (cached !== undefined && Date.now() - cached.at < LATEST_TTL_MS) {
    return cached.version;
  }
  let version: string | null = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const parsed = manifestSchema.safeParse(await response.json());
      if (parsed.success) version = versionFrom(parsed.data.version);
    }
  } catch {
    version = null;
  }
  latestCache.set(url, { version, at: Date.now() });
  return version;
}

async function installedVersion(): Promise<string | null> {
  return versionFrom((await runAgy(["--version"], 10_000))?.trim() ?? null);
}

export async function agyHealth(): Promise<ProviderHealthResult> {
  const installed = findAgy() !== null;
  return {
    supported: true,
    health: {
      status: installed ? "ready" : "not_installed",
      statusMessage: installed
        ? null
        : "agy was not found in ~/.local/bin or on PATH",
      accountEmail: null,
      planLabel: null,
      installedVersion: installed ? await installedVersion() : null,
      minimumSupportedVersion: null,
      canInstall: !installed,
      canUpdate: installed,
      loginCommand: "agy",
    },
  } as ProviderHealthResult;
}

export async function agyInstallationStatus(): Promise<ProviderInstallationStatus> {
  const executable = findAgy();
  const installed = executable !== null;
  const [currentVersion, latestVersion] = await Promise.all([
    installed ? installedVersion() : Promise.resolve(null),
    latestAgyVersion(),
  ]);
  const needsUpdate =
    installed &&
    currentVersion !== null &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  return {
    executableName: "agy",
    executablePath: executable,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    needsUpdate,
    versionUnsupported: false,
    installAction: !installed
      ? {
          kind: "install",
          label: "Install",
          command: downloadedInstallerCommand(AGY_INSTALL_SCRIPT_URL)
            .displayCommand,
        }
      : needsUpdate
        ? {
            kind: "update",
            label: "Update",
            command: formatCommand(executable, ["update"]),
          }
        : null,
  };
}

export async function agyInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await agyInstallationStatus();
  const executable = status.executablePath;
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `Antigravity ${action} is no longer available on this host.`,
    };
  }
  const command =
    action === "install"
      ? downloadedInstallerCommand(AGY_INSTALL_SCRIPT_URL)
      : executable === null
        ? null
        : {
            command: executable,
            args: ["update"],
            displayCommand: formatCommand(executable, ["update"]),
          };
  if (command === null) {
    return {
      available: false,
      message: "agy was not found on this host.",
    };
  }
  return {
    available: true,
    command,
    verification: installationVerification(status, action),
  };
}

const USAGE_TTL_MS = 2 * 60_000;

const USAGE_LINE =
  /^(.+?)\t(Weekly|Five Hour) Limit Remaining\t(\d+(?:\.\d+)?)%\t(\S+)\s*$/u;

let usageCache: { result: ProviderUsageResult; at: number } | null = null;

export function parseAgyUsage(stdout: string): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const line of stdout.split("\n")) {
    const match = USAGE_LINE.exec(line);
    if (match === null) continue;
    const [, group, span, remaining, resetsAt] = match;
    const weekly = span === "Weekly";
    windows.push({
      label: `${group} (${weekly ? "weekly" : "5-hour"})`,
      kind: weekly ? "weekly" : "five-hour",
      model: group,
      usedPercent: clampPercent(100 - Number(remaining)),
      resetsAt:
        resetsAt !== undefined && !Number.isNaN(Date.parse(resetsAt))
          ? new Date(resetsAt).toISOString()
          : null,
    });
  }
  return windows;
}

export async function agyUsage(): Promise<ProviderUsageResult> {
  if (usageCache !== null && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return usageCache.result;
  }
  let result: ProviderUsageResult;
  if (findAgy() === null) {
    result = { supported: true, usage: { status: "not_installed" } };
  } else {
    const stdout = await runAgy(["-p=/usage"], 30_000);
    const windows = stdout === null ? [] : parseAgyUsage(stdout);
    result =
      windows.length > 0
        ? {
            supported: true,
            usage: {
              status: "ok",
              accountEmail: null,
              planLabel: null,
              windows,
            },
          }
        : {
            supported: true,
            usage: {
              status: "error",
              accountEmail: null,
              planLabel: null,
              message:
                stdout === null
                  ? "agy /usage failed; run agy in a terminal to check the sign-in"
                  : "agy /usage returned no limits",
            },
          };
  }
  usageCache = { result, at: Date.now() };
  return result;
}
