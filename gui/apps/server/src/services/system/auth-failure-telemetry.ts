import { countThreads, getThread, type DbConnection } from "@cloudroom/db";
import type { ServerLogger } from "../../types.js";
import { buildTurnFailedEvent } from "../threads/turn-failed.js";
import type { TelemetryService } from "./telemetry.js";

interface Deps {
  db: DbConnection;
  logger: ServerLogger;
  telemetry: TelemetryService;
}

let deps: Deps | null = null;

export function installAuthFailureTelemetry(next: Deps): () => void {
  deps = next;
  return () => {
    if (deps === next) deps = null;
  };
}

export function noteTurnFailed(threadId: string): void {
  const current = deps;
  if (!current) return;
  setImmediate(() => {
    const thread = getThread(current.db, threadId);
    if (!thread || thread.deletedAt !== null) return;
    const failed = buildTurnFailedEvent(current.db, threadId);
    const execution = thread.executionTarget === "cloud" ? "cloud_sandbox" : "local";
    current.telemetry.capture({
      name: "turn_failed",
      properties: {
        execution,
        is_child_thread: thread.parentThreadId !== null,
        provider: thread.providerId,
        error_category: failed?.errorInfo?.category ?? "unknown",
      },
    });
    if (failed?.errorInfo?.category !== "unauthorized") return;
    const running = countThreads(current.db, {
      status: "active",
      providerId: thread.providerId,
      includeHidden: true,
    }).total;
    current.logger.warn(
      {
        threadId,
        provider: thread.providerId,
        providerCode: failed.errorInfo.providerCode,
        execution,
        runningThreads: running,
      },
      "Provider login failed",
    );
    current.telemetry.capture({
      name: "provider_auth_failed",
      properties: {
        execution,
        provider: thread.providerId,
        provider_code: failed.errorInfo.providerCode,
        running_threads: running,
      },
    });
  });
}
