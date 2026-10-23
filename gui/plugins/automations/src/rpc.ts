import {
  automationListResponseSchema,
  automationReadResultSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
  automationRunsInputSchema,
  automationsOverviewResponseSchema,
  type AutomationAgentSummary,
  createAutomationInputSchema,
  linkThreadInputSchema,
  listAutomationsInputSchema,
  projectAutomationInputSchema,
  reasoningLevelSchema,
  reviewMarkInputSchema,
  reviewResponseSchema,
  runAutomationInputSchema,
  updateAutomationInputSchema,
} from "./rpc-types.js";
import { z } from "zod";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { AutomationService } from "./service.js";

const cloudAutomationInputSchema = z
  .object({
    action: z.enum(["list", "create", "update", "run", "delete", "hook"]),
  })
  .passthrough();

const cloudTemplateInputSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    prompt: z.string().min(1),
    cron: z.string().min(1),
    timezone: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema,
  })
  .strict();

export const automationRpcContract = defineRpcContract({
  automations_overview: {
    input: z.null(),
    output: automationsOverviewResponseSchema,
  },
  automations_list: {
    input: listAutomationsInputSchema,
    output: automationListResponseSchema,
  },
  automations_get: {
    input: projectAutomationInputSchema,
    output: automationReadResultSchema,
  },
  automations_create: {
    input: createAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_update: {
    input: updateAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_delete: {
    input: projectAutomationInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_pause: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_resume: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_run: {
    input: runAutomationInputSchema,
    output: automationRunRpcResponseSchema,
  },
  // A webhook loop's new secret URL (ADR 0262), shown once.
  automations_new_webhook_url: {
    input: projectAutomationInputSchema,
    output: automationResponseSchema,
  },
  automations_runs: {
    input: automationRunsInputSchema,
    output: automationRunListResponseSchema,
  },
  automations_review: {
    input: z.null(),
    output: reviewResponseSchema,
  },
  automations_review_mark: {
    input: reviewMarkInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  automations_link_thread: {
    input: linkThreadInputSchema,
    output: z.object({ linked: z.boolean() }).strict(),
  },
  // Cloud automations (ADR 0212) live on the website; the app passes requests through.
  cloud_automations: {
    input: cloudAutomationInputSchema,
    output: z.unknown(),
  },
  cloud_template_add: {
    input: cloudTemplateInputSchema,
    output: z.unknown(),
  },
});

type Sdk = Pick<BbPluginApi["sdk"], "cloudroom" | "threads">;
type Cloud = Sdk["cloudroom"];
type CloudAutomation = NonNullable<
  Awaited<ReturnType<Cloud["automations"]>>["automation"]
>;

type CloudThread = Awaited<ReturnType<Sdk["threads"]["get"]>>;

async function cloudThreadAgent(
  threads: Sdk["threads"],
  thread: CloudThread,
): Promise<AutomationAgentSummary | null> {
  try {
    const options = await threads.defaultExecutionOptions({
      threadId: thread.id,
    });
    return {
      providerId: "providerId" in thread ? thread.providerId : null,
      model: options?.model ?? null,
      reasoningLevel: options?.reasoningLevel ?? null,
    };
  } catch {
    return null;
  }
}

async function withCloudAgents(threads: Sdk["threads"], result: unknown) {
  const { automations = [] } = result as {
    automations?: Pick<CloudAutomation, "thread_id" | "agent">[];
  };
  return {
    ...(result as object),
    // A fresh-thread loop's own saved agent; otherwise its thread's, which it uses. Its project is its thread's.
    automations: await Promise.all(
      automations.map(async (automation) => {
        const thread = await threads
          .get({ threadId: automation.thread_id })
          .catch(() => null);
        return {
          ...automation,
          project_id: thread && "projectId" in thread ? thread.projectId : null,
          agent: automation.agent
            ? {
                providerId: automation.agent.provider,
                model: automation.agent.model,
                reasoningLevel: automation.agent.reasoning,
              }
            : thread
              ? await cloudThreadAgent(threads, thread)
              : null,
        };
      }),
    ),
  };
}

const HOST_START_TIMEOUT_MS = 5 * 60_000;

async function hasCloudSession(sdk: Sdk, threadId: string): Promise<boolean> {
  const status = (await sdk.cloudroom
    .threadStatus(threadId)
    .catch(() => null)) as { sessionId?: string | null } | null;
  return Boolean(status?.sessionId);
}

// A Cloud loop needs an open, started Cloud thread in its project: the newest one, else a new one started for it.
async function cloudTemplateHost(
  sdk: Sdk,
  input: z.output<typeof cloudTemplateInputSchema>,
): Promise<string> {
  const threads = await sdk.threads.list({
    projectId: input.projectId,
    archived: false,
  });
  const open = threads
    .filter(
      (thread) =>
        thread.executionTarget === "cloud" &&
        thread.archivedAt === null &&
        thread.deletedAt === null,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const thread of open) {
    // "starting" may still be copying the project into its sandbox.
    if (thread.status !== "idle" && thread.status !== "active") continue;
    if (await hasCloudSession(sdk, thread.id)) return thread.id;
  }
  const thread = await sdk.threads.spawn({
    projectId: input.projectId,
    executionTarget: "cloud",
    environment: { type: "project-default" },
    title: `${input.name} loop`,
    providerId: input.providerId,
    model: input.model,
    reasoningLevel: "low",
    prompt: `This Cloud thread hosts the "${input.name}" loop, added from Loops → Templates. Each run starts its own fresh thread. First run \`room-cli files wait\`. If it says the project copy failed, reply with one word: Failed. Otherwise reply with one word: Ready.`,
  });
  // The session exists before the project finishes copying, so wait for the reply its prompt gives after `files wait`.
  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  for (;;) {
    const status = (await sdk.threads.get({ threadId: thread.id }))?.status;
    if (status === "error")
      throw new Error("its new Cloud thread failed to start");
    if (status === "idle") {
      const { output } = await sdk.threads.output({ threadId: thread.id });
      if (/\bready\b/i.test(output ?? "")) return thread.id;
      if (output)
        throw new Error("its project did not finish copying to the cloud");
    }
    if (Date.now() > deadline)
      throw new Error("its new Cloud thread did not start within 5 minutes");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

export function createRpcHandlers(service: AutomationService, sdk?: Sdk) {
  return {
    async cloud_automations(
      input: z.output<typeof cloudAutomationInputSchema>,
    ) {
      if (!sdk) throw new Error("Cloud automations are unavailable.");
      const result = await sdk.cloudroom.automations(
        input as Parameters<Cloud["automations"]>[0],
      );
      return input.action === "list"
        ? withCloudAgents(sdk.threads, result)
        : result;
    },
    async cloud_template_add(
      input: z.output<typeof cloudTemplateInputSchema>,
    ) {
      if (!sdk) throw new Error("Cloud loops are unavailable.");
      return sdk.cloudroom.automations({
        action: "create",
        thread: await cloudTemplateHost(sdk, input),
        name: input.name,
        prompt: input.prompt,
        cron: input.cron,
        timezone: input.timezone,
        harness: input.providerId,
        model: input.model,
        reasoning: input.reasoningLevel,
      });
    },
    automations_overview() {
      return service.overview();
    },
    automations_list(input: z.output<typeof listAutomationsInputSchema>) {
      return service.list(input);
    },
    automations_get(input: z.output<typeof projectAutomationInputSchema>) {
      return service.get(input);
    },
    automations_create(input: z.output<typeof createAutomationInputSchema>) {
      return service.create(input);
    },
    automations_update(input: z.output<typeof updateAutomationInputSchema>) {
      return service.update(input);
    },
    automations_delete(input: z.output<typeof projectAutomationInputSchema>) {
      return service.delete(input);
    },
    automations_pause(input: z.output<typeof projectAutomationInputSchema>) {
      return service.pause(input);
    },
    automations_resume(input: z.output<typeof projectAutomationInputSchema>) {
      return service.resume(input);
    },
    automations_run(input: z.output<typeof runAutomationInputSchema>) {
      return service.run(input);
    },
    automations_new_webhook_url(
      input: z.output<typeof projectAutomationInputSchema>,
    ) {
      return service.newWebhookUrl(input);
    },
    automations_runs(input: z.output<typeof automationRunsInputSchema>) {
      return service.runs(input);
    },
    automations_review() {
      return service.review();
    },
    automations_review_mark(input: z.output<typeof reviewMarkInputSchema>) {
      return service.markReviewed(input);
    },
    automations_link_thread(input: z.output<typeof linkThreadInputSchema>) {
      return service.linkThread(input);
    },
  };
}
