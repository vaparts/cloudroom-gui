import { eq } from "drizzle-orm";
import { getEnvironment, getThread, listEvents, threads } from "@cloudroom/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  type PromptInput,
} from "@cloudroom/domain";
import { describe, expect, it } from "vitest";
import { validatePromptAttachmentReferences } from "../../src/services/projects/attachments.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedTwoProjects(harness: TestAppHarness, status: "idle" | "active") {
  const { host } = seedHostSession(harness.deps);
  const { project: from } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "legal",
    path: "/tmp/move-from",
  });
  const { project: to } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    name: "cloudroom",
    path: "/tmp/move-to",
  });
  const oldEnvironment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: from.id,
    path: "/tmp/move-from",
    environmentProviderId: "git-worktree",
    providerOwnsPath: true,
  });
  const newEnvironment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: to.id,
    path: "/tmp/move-to",
  });
  const thread = seedThread(harness.deps, {
    projectId: from.id,
    environmentId: oldEnvironment.id,
    status,
  });
  seedStoredEvent(harness.deps, {
    threadId: thread.id,
    sequence: 1,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      input: [{ type: "text", text: "Draft the contract", mentions: [] }],
      target: { kind: "thread-start" },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      initiator: "user",
      senderThreadId: null,
      request: { method: "turn/start", params: {} },
      source: "tell",
    },
  });
  return { thread, to, oldEnvironment, newEnvironment };
}

function move(harness: TestAppHarness, threadId: string, projectId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
}

async function releaseOldRuntime(harness: TestAppHarness, threadId: string) {
  const stop = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.stop" && command.threadId === threadId,
  );
  await reportQueuedCommandSuccess(harness, stop, {
    providerCheckpointId: null,
  });
}

describe("thread move", () => {
  it("moves the label and folder together, keeps the old worktree, and seeds the new project", async () => {
    await withTestHarness(async (harness) => {
      const { thread, to, oldEnvironment, newEnvironment } = seedTwoProjects(
        harness,
        "idle",
      );

      const pending = move(harness, thread.id, "Cloudroom");
      await releaseOldRuntime(harness, thread.id);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        moved: true,
        previousPath: "/tmp/move-from",
      });
      const moved = getThread(harness.db, thread.id);
      expect(moved?.projectId).toBe(to.id);
      expect(moved?.environmentId).toBe(newEnvironment.id);
      const switches = listEvents(harness.db, { threadId: thread.id }).filter(
        (event) =>
          event.type === "system/operation" &&
          JSON.parse(event.data).operation === "harness_switch",
      );
      expect(switches).toHaveLength(1);
      const seed = (
        JSON.parse(switches[0]!.data) as { metadata: { seed: PromptInput[] } }
      ).metadata.seed;
      expect(seed).toHaveLength(2);
      await validatePromptAttachmentReferences({
        dataDir: harness.config.dataDir,
        projectId: to.id,
        input: seed,
      });
      expect(getEnvironment(harness.db, oldEnvironment.id)).toMatchObject({
        environmentProviderId: null,
        retireAt: null,
      });
    });
  });

  it("waits for a running turn to end, then moves", async () => {
    await withTestHarness(async (harness) => {
      const { thread, to } = seedTwoProjects(harness, "active");

      const response = await move(harness, thread.id, to.id);

      expect(await response.json()).toMatchObject({ moved: false });
      expect(getThread(harness.db, thread.id)?.projectId).not.toBe(to.id);
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();
      const ready = runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await releaseOldRuntime(harness, thread.id);
      await ready;
      expect(getThread(harness.db, thread.id)?.projectId).toBe(to.id);
    });
  });
});
