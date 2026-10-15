import {
  sanitizeInheritedChildProcessEnv,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { AGY_EXECUTABLE_ENV } from "./vocabulary.js";

export function findAgy(): string | null {
  const pinned = process.env[AGY_EXECUTABLE_ENV];
  if (pinned && existsSync(pinned)) return pinned;
  const local = join(homedir(), ".local", "bin", "agy");
  if (existsSync(local)) return local;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "agy"))) return join(dir, "agy");
  }
  return null;
}

export function childEnv(
  extra: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  return {
    ...sanitizeInheritedChildProcessEnv({
      env: withoutBridgeRuntimeEnv(process.env),
    }),
    ...(extra ?? {}),
  };
}

export function runAgy(
  args: string[],
  timeout: number,
): Promise<string | null> {
  const executable = findAgy();
  if (executable === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      { timeout, env: childEnv(undefined) },
      (error, stdout) => {
        resolve(error ? null : stdout);
      },
    );
  });
}
