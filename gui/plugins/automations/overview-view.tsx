import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  type PluginProvidersState,
} from "@get-bb/plugin-sdk/app";
import type {
  AutomationAgentSummary,
  AutomationReadProblem,
  AutomationResponse,
  AutomationsOverviewResponse,
  ReviewResponse,
} from "./src/rpc-types.js";
import { AutomationLifecycleControl } from "./detail-view.js";
import { Icon } from "@cloudroom/shared-ui/icon";
import { DelayedLoading } from "@cloudroom/shared-ui/delayed-loading";
import { COARSE_POINTER_ICON_SIZE_SHRINK_CLASS } from "@cloudroom/shared-ui/coarse-pointer-sizing";
import {
  ResourceActionButton,
  ResourceCollectionPage,
  ResourceCollectionViewport,
  ResourceListState,
  ResourceFilterMenu,
  ResourceMeta,
  ResourceRow,
  ResourceSortMenu,
} from "@cloudroom/shared-ui/resource-list";
import { Input } from "@cloudroom/shared-ui/input";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import {
  type AutomationStatusFilter,
  formatAutomationTrigger,
  isCloudWebhook,
  formatOverviewScheduleMetadata,
  formatScheduleRunTime,
  formatScheduleStatusLabel,
  formatTimeUntil,
  getOneShotLifecycle,
  matchesAutomationStatusFilters,
  oneShotLifecycleAllowsToggle,
  PERSONAL_PROJECT_ID,
} from "./lib/format-schedule.js";
import { AutomationMetadataItem } from "./metadata.js";
import {
  LoopTemplatesView,
  type LoopTemplatesState,
  LOOP_PRIORITY_STYLE,
  LoopGroupDivider,
} from "./templates-view.js";
import type { CloudAutomation, CloudAutomationActions } from "./cloud-view.js";
import { CloudLoopDialog } from "./loop-dialog.js";
import {
  LoopReviewView,
  reviewableItems,
  ReviewToolbar,
  type ReviewFilter,
  type ReviewLayout,
} from "./review-view.js";

const OVERVIEW_BAND_CLASSES = "mx-auto w-full max-w-3xl";

const AUTOMATION_STATUS_FILTER_OPTIONS = [
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
] as const;

export const CREATE_AUTOMATION_PROMPT = "Create a new Cloudroom loop to ";
// The New button's menu (ADR 0262, design 1): pick the trigger, then finish the sentence in chat.
const NEW_LOOP_OPTIONS = [
  {
    label: "On a schedule",
    description: "Every hour, every weekday at 9…",
    icon: "TimeSchedule",
    prompt: "Create a new Cloudroom loop that runs on a schedule to ",
  },
  {
    label: "Once",
    description: "At a time, or in 30 minutes",
    icon: "Calendar",
    prompt: "Create a new Cloudroom loop that runs once to ",
  },
  {
    label: "On a webhook",
    description: "Runs when a URL gets a POST",
    icon: "Link",
    prompt: "Create a new Cloudroom loop that runs on a webhook to ",
    isNew: true,
  },
  {
    label: "Describe it in chat",
    description: "An agent sets it up for you",
    icon: "SideChat",
    prompt: CREATE_AUTOMATION_PROMPT,
    divider: true,
  },
] as const;

type OverviewEntry = AutomationsOverviewResponse["automations"][number];
type AutomationProjectFilter = `project:${string}`;
type AutomationSortMode = "next" | "project" | "alpha";
type ProviderList = PluginProvidersState["providers"];
type AutomationSortDirection = "asc" | "desc";
export type AutomationCollectionMode = "installed" | "review" | "templates";

export interface LoopReviewState {
  data: ReviewResponse | null;
  error: string | null;
  onRetry: () => void;
  onOpenThread: (threadId: string) => void;
  onMark: (itemIds: string[], reviewed: boolean) => void;
}
type ReadableOverviewAutomation =
  | AutomationResponse
  | Extract<AutomationReadProblem, { problem: "missing-agent-prompt" }>;

interface AutomationDetailRoute {
  projectId: string;
  automationId: string;
}

interface AutomationDetailNavigationOptions {
  editing?: boolean;
}

function routeOf(
  automation: Pick<AutomationResponse, "id" | "projectId">,
): AutomationDetailRoute {
  return { projectId: automation.projectId, automationId: automation.id };
}

const LAST_RUN_DOT = {
  succeeded: { label: "Last run succeeded", className: "bg-success" },
  skipped: { label: "Last run skipped", className: "bg-muted-foreground/50" },
  failed: { label: "Last run failed", className: "bg-destructive" },
  running: { label: "Running", className: "animate-pulse bg-primary" },
} as const;

const LOOP_PRIORITIES = [1, 2, 3, 4] as const;
type LoopPriority = (typeof LOOP_PRIORITIES)[number];
const DEFAULT_LOOP_PRIORITY: LoopPriority = 3;
const LOOP_PRIORITY_STORAGE_KEY = "cloudroom-loops:priorities";

function isLoopPriority(value: unknown): value is LoopPriority {
  return LOOP_PRIORITIES.includes(value as LoopPriority);
}

function readLoopPriorities(): Record<string, LoopPriority> {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(LOOP_PRIORITY_STORAGE_KEY) ?? "{}",
    );
    if (parsed === null || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => isLoopPriority(value)),
    ) as Record<string, LoopPriority>;
  } catch {
    return {};
  }
}

function saveLoopPriority(
  key: string,
  priority: LoopPriority,
): Record<string, LoopPriority> {
  const next = { ...readLoopPriorities(), [key]: priority };
  try {
    window.localStorage.setItem(
      LOOP_PRIORITY_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    return next;
  }
  return next;
}

function useLoopPriorities() {
  const [priorities, setPriorities] = useState(readLoopPriorities);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LOOP_PRIORITY_STORAGE_KEY) {
        setPriorities(readLoopPriorities());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const setPriority = useCallback((key: string, priority: LoopPriority) => {
    setPriorities(saveLoopPriority(key, priority));
  }, []);
  return { priorities, setPriority };
}

function LoopPriorityMenu({
  priority,
  name,
  onChange,
}: {
  priority: LoopPriority;
  name: string;
  onChange: (priority: LoopPriority) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-row-action
          aria-label={`Priority ${priority} for ${name}. Change priority`}
          className="flex size-6 cursor-pointer items-center justify-center rounded-full hover:bg-state-hover"
        >
          <span
            className={cn(
              "size-4 rounded-full border-2",
              LOOP_PRIORITY_STYLE[priority].ring,
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-40"
        onClick={(event) => event.stopPropagation()}
      >
        {LOOP_PRIORITIES.map((level) => (
          <DropdownMenuItem
            key={level}
            className="gap-2"
            onSelect={() => onChange(level)}
          >
            <span
              className={cn(
                "size-3.5 rounded-full border-2",
                LOOP_PRIORITY_STYLE[level].ring,
              )}
            />
            Priority {level}
            {level === priority ? (
              <Icon name="Check" className="ml-auto size-3.5" aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AutomationStatusDot({
  status,
}: {
  status: AutomationResponse["lastRunStatus"];
}) {
  return (
    <span
      role="img"
      aria-label={status === null ? "Not run yet" : LAST_RUN_DOT[status].label}
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        status === null
          ? "ring-1 ring-inset ring-muted-foreground/50"
          : LAST_RUN_DOT[status].className,
      )}
    />
  );
}

function formatModelName(model: string): string {
  const [, base = model, context] = /^(.+?)(?:\[(\w+)\])?$/u.exec(model) ?? [];
  const name = (base.split("/").at(-1) ?? base)
    .replace(/^claude-/u, "")
    .split("-")
    .map((part) =>
      part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ")
    .replace(/(\d) (?=\d)/gu, "$1.")
    .replace(/^GPT /u, "GPT-");
  return context === undefined ? name : `${name} (${context.toUpperCase()})`;
}

function automationAgents(
  automation: AutomationResponse,
  scriptAgents: readonly AutomationAgentSummary[] | undefined,
): readonly AutomationAgentSummary[] {
  const { execution } = automation;
  if (execution.mode === "script") return scriptAgents ?? [];
  return [
    {
      providerId: execution.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
    },
  ];
}

function AutomationAgentLine({
  agents,
  providers,
  compact = false,
}: {
  agents: readonly AutomationAgentSummary[];
  providers: ProviderList;
  /** Logo instead of the harness name, for narrow cards. */
  compact?: boolean;
}) {
  if (agents.length === 0) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          name="ComputerTerminal01"
          className="size-3.5 shrink-0"
          aria-hidden
        />
        Script
      </span>
    );
  }
  const providerIds = [...new Set(agents.map((agent) => agent.providerId))];
  const models = [
    ...new Set(
      agents.flatMap((agent) =>
        agent.model === null || agent.model === "default"
          ? []
          : [formatModelName(agent.model)],
      ),
    ),
  ];
  const levels = [
    ...new Set(
      agents.flatMap((agent) =>
        agent.reasoningLevel === null ? [] : [agent.reasoningLevel],
      ),
    ),
  ];
  const providerOf = (id: string) => providers.find((info) => info.id === id);
  const levelLabel = (level: string) =>
    providers
      .flatMap((info) => info.reasoningLevels ?? [])
      .find((option) => option.id === level)?.label ?? level;
  const parts = [
    compact
      ? ""
      : providerIds
          .map((id) =>
            id === null ? "Agent" : (providerOf(id)?.displayName ?? id),
          )
          .join(" ⇄ "),
    models.join(" ⇄ "),
    levels.map(levelLabel).join(" ⇄ "),
  ].filter((part) => part !== "");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="flex shrink-0 items-center">
        {providerIds.map((id, index) =>
          id === null ? (
            <Icon key="default" name="Bot" className="size-3.5" aria-hidden />
          ) : (
            <ProviderIcon
              key={id}
              providerKind="agent"
              provider={providerOf(id) ?? { id }}
              fallback="Bot"
              className={cn("size-3.5", index > 0 && "-ml-1")}
              aria-hidden
            />
          ),
        )}
      </span>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate",
              part === levelLabel("max") && "text-primary",
            )}
          >
            {part}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function automationNextRunText(
  automation: AutomationResponse,
  now: number,
): string {
  if (automation.lastRunStatus === "running") return "Running";
  const metadata = formatOverviewScheduleMetadata({
    enabled: automation.enabled,
    nextRunAt: automation.nextRunAt,
    trigger: automation.trigger,
    runCount: automation.runCount,
    lastRunStatus: automation.lastRunStatus,
    now,
  });
  if (metadata?.isNextRun && automation.nextRunAt !== null) {
    return formatTimeUntil(automation.nextRunAt, now);
  }
  return formatScheduleStatusLabel({ ...automation, now }).split(" — ")[0]!;
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function automationProjectLabel(
  project: OverviewEntry["project"],
): string {
  return project.name;
}

function automationProjectFilterId(
  entry: OverviewEntry,
): AutomationProjectFilter {
  const projectId = entry.project.id;
  return `project:${projectId}`;
}

function isAutomationProjectFilter(
  value: string,
): value is AutomationProjectFilter {
  return value.startsWith("project:");
}

function isAutomationStatusFilter(
  value: string,
): value is AutomationStatusFilter {
  return AUTOMATION_STATUS_FILTER_OPTIONS.some((option) => option.id === value);
}

function applyAutomationSortDirection(
  result: number,
  direction: AutomationSortDirection,
): number {
  return direction === "asc" ? result : -result;
}

function automationLifecycleSortRank(automation: AutomationResponse): number {
  const oneShotLifecycle = getOneShotLifecycle({
    enabled: automation.enabled,
    trigger: automation.trigger,
    runCount: automation.runCount,
    lastRunStatus: automation.lastRunStatus,
  });
  if (oneShotLifecycle === "completed") return 3;
  if (!automation.enabled && oneShotLifecycle !== "running") return 2;
  if (oneShotLifecycle === "scheduled") return 1;
  return 0;
}

function AutomationRowMetadata({
  automation,
  project,
}: {
  automation: ReadableOverviewAutomation | null;
  project: OverviewEntry["project"];
}) {
  const projectLabel = automationProjectLabel(project);
  const personalProject = project.id === PERSONAL_PROJECT_ID;
  const scheduleMetadata =
    automation === null
      ? null
      : formatOverviewScheduleMetadata({
          enabled: automation.enabled,
          nextRunAt: automation.nextRunAt,
          trigger: automation.trigger,
          runCount: automation.runCount,
          lastRunStatus: automation.lastRunStatus,
        });
  return (
    <ResourceMeta
      items={[
        <AutomationMetadataItem
          icon="Folder"
          iconLabel={personalProject ? `Project: ${projectLabel}` : "Project"}
          title={projectLabel}
        >
          {projectLabel}
        </AutomationMetadataItem>,
        automation !== null ? (
          <AutomationMetadataItem icon="DateTime" iconLabel="Schedule">
            {formatAutomationTrigger(automation.trigger)}
          </AutomationMetadataItem>
        ) : null,
        automation !== null && scheduleMetadata !== null ? (
          <AutomationMetadataItem
            icon={scheduleMetadata.isNextRun ? "CalendarCheckOut02" : undefined}
            iconLabel={scheduleMetadata.isNextRun ? "Next run" : undefined}
          >
            {scheduleMetadata.text}
          </AutomationMetadataItem>
        ) : null,
        automation === null ? "The stored configuration cannot be read." : null,
      ]}
    />
  );
}

function FailedBadge({ error }: { error: string | null }) {
  return (
    <span
      title={error ?? undefined}
      className="inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap rounded-full bg-destructive/10 px-2 py-0.5 text-2xs font-medium text-destructive-text"
    >
      <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
      Failed
    </span>
  );
}

function NeedsYouBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 self-center whitespace-nowrap rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning-text">
      <span className="size-1.5 rounded-full bg-warning" aria-hidden />
      {count} need{count === 1 ? "s" : ""} you
    </span>
  );
}

function LoopStat({
  label,
  value,
  className,
  onClick,
}: {
  label: string;
  value: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={onClick === undefined}
      onClick={onClick}
      className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-left transition-colors enabled:cursor-pointer enabled:hover:border-foreground/20"
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums text-foreground",
          className,
        )}
      >
        {value}
      </div>
    </button>
  );
}

function LoopLocation({ cloud }: { cloud: boolean }) {
  return (
    <>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1",
          cloud ? "text-primary-text" : "text-muted-foreground",
        )}
      >
        <Icon
          name={cloud ? "Cloud" : "Laptop"}
          className="size-3.5"
          aria-hidden
        />
        {cloud ? "Cloud" : "Local"}
      </span>
      <span aria-hidden className="text-muted-foreground/40">
        ·
      </span>
    </>
  );
}

function AutomationListRow({
  cloud,
  leading,
  status,
  lastError = null,
  name,
  agentLine,
  schedule,
  nextRun,
  nextRunAt,
  enabled,
  muted,
  needsYou,
  toggle,
  actions,
  openLabel,
  onOpen,
}: {
  cloud: boolean;
  leading?: ReactNode;
  status: AutomationResponse["lastRunStatus"];
  lastError?: string | null;
  name: string;
  agentLine: ReactNode;
  schedule: string;
  nextRun: string;
  nextRunAt: number | null;
  enabled: boolean;
  muted: boolean;
  needsYou: number;
  toggle: ReactNode;
  actions?: ReactNode;
  openLabel?: string;
  onOpen: () => void;
}) {
  return (
    <ResourceRow
      leading={leading ?? <AutomationStatusDot status={status} />}
      title={name}
      state={
        <>
          {status === "failed" ? <FailedBadge error={lastError} /> : null}
          <NeedsYouBadge count={needsYou} />
        </>
      }
      description={
        <>
          <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-muted-foreground/80">
            <LoopLocation cloud={cloud} />
            {agentLine}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate" title={schedule}>
              {schedule}
            </span>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span
              className={cn(
                "shrink-0 whitespace-nowrap tabular-nums",
                nextRun === "Running"
                  ? "font-medium text-primary-text"
                  : enabled && nextRun.startsWith("in ")
                    ? "font-mono text-foreground"
                    : undefined,
              )}
              title={
                nextRunAt === null
                  ? undefined
                  : formatScheduleRunTime(nextRunAt)
              }
            >
              {nextRun}
            </span>
          </span>
        </>
      }
      className="rounded-lg border border-border bg-surface-raised px-4 transition-colors hover:border-foreground/20"
      muted={muted}
      openLabel={openLabel}
      onOpen={onOpen}
      actions={actions}
      persistentActions={toggle}
    />
  );
}

export function OverviewRow({
  automation,
  project,
  scriptAgents,
  providers,
  showProject,
  now,
  needsYou = 0,
  leading,
  onNavigate,
  onEnabledChange,
}: {
  automation: AutomationResponse;
  project: OverviewEntry["project"];
  scriptAgents: readonly AutomationAgentSummary[] | undefined;
  providers: ProviderList;
  showProject: boolean;
  now: number;
  needsYou?: number;
  leading?: ReactNode;
  onNavigate: (route: AutomationDetailRoute) => void;
  onEnabledChange: (
    enabled: boolean,
    route: AutomationDetailRoute,
  ) => Promise<void>;
}) {
  const [togglePending, setTogglePending] = useState(false);
  const route = routeOf(automation);
  const oneShotLifecycle = getOneShotLifecycle({
    enabled: automation.enabled,
    trigger: automation.trigger,
    runCount: automation.runCount,
    lastRunStatus: automation.lastRunStatus,
  });
  const lifecycleLocked = !oneShotLifecycleAllowsToggle(oneShotLifecycle);
  const projectLabel = automationProjectLabel(project);

  return (
    <AutomationListRow
      cloud={false}
      leading={leading}
      status={automation.lastRunStatus}
      lastError={automation.lastError}
      name={automation.name}
      agentLine={
        <>
          <AutomationAgentLine
            agents={automationAgents(automation, scriptAgents)}
            providers={providers}
          />
          {showProject ? (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <AutomationMetadataItem
                icon="Folder"
                iconLabel={
                  project.id === PERSONAL_PROJECT_ID
                    ? `Project: ${projectLabel}`
                    : "Project"
                }
                title={projectLabel}
              >
                {projectLabel}
              </AutomationMetadataItem>
            </>
          ) : null}
        </>
      }
      needsYou={needsYou}
      schedule={formatAutomationTrigger(automation.trigger)}
      nextRun={automationNextRunText(automation, now)}
      nextRunAt={automation.nextRunAt}
      enabled={automation.enabled}
      muted={lifecycleLocked}
      onOpen={() => onNavigate(route)}
      toggle={
        <AutomationLifecycleControl
          checked={automation.enabled && !lifecycleLocked}
          disabled={lifecycleLocked || togglePending}
          disabledReason={
            lifecycleLocked
              ? oneShotLifecycle === "expired"
                ? "Missed its run time. Edit to reschedule."
                : "Already ran. Edit to reschedule."
              : undefined
          }
          label={`${automation.enabled ? "Disable" : "Enable"} ${automation.name}`}
          onCheckedChange={(enabled) => {
            setTogglePending(true);
            void onEnabledChange(enabled, route).finally(() =>
              setTogglePending(false),
            );
          }}
        />
      }
    />
  );
}

export function CloudAutomationRow({
  automation,
  providers,
  now,
  needsYou = 0,
  leading,
  actions,
}: {
  automation: CloudAutomation;
  providers: ProviderList;
  now: number;
  needsYou?: number;
  leading?: ReactNode;
  actions: CloudAutomationActions;
}) {
  const nextRunAt =
    automation.next_run_at === null ? null : Date.parse(automation.next_run_at);
  return (
    <AutomationListRow
      cloud
      leading={leading}
      status={
        automation.last_error !== null
          ? "failed"
          : automation.last_run_at !== null
            ? "succeeded"
            : null
      }
      lastError={automation.last_error}
      name={automation.name}
      agentLine={
        <AutomationAgentLine
          agents={[
            automation.agent ?? {
              providerId: null,
              model: null,
              reasoningLevel: null,
            },
          ]}
          providers={providers}
        />
      }
      needsYou={needsYou}
      schedule={
        isCloudWebhook(automation)
          ? "On webhook"
          : automation.cron === null
            ? "One time"
            : formatAutomationTrigger({
                triggerType: "schedule",
                cron: automation.cron,
                timezone: automation.timezone,
              })
      }
      nextRun={
        !automation.enabled
          ? "Paused"
          : nextRunAt === null
            ? isCloudWebhook(automation)
              ? "Waits for a webhook"
              : "Starts soon"
            : formatTimeUntil(nextRunAt, now)
      }
      nextRunAt={nextRunAt}
      enabled={automation.enabled}
      muted={!automation.enabled}
      openLabel="Open Cloud thread"
      onOpen={() => actions.onOpen(automation)}
      actions={
        <>
          {isCloudWebhook(automation) ? (
            <ResourceActionButton
              label="New webhook URL"
              icon="Link"
              onClick={() => actions.onNewUrl(automation)}
            />
          ) : (
            <ResourceActionButton
              label="Run now"
              icon="Play"
              onClick={() => actions.onRun(automation)}
            />
          )}
          <ResourceActionButton
            label="Delete"
            icon="Trash2"
            onClick={() => actions.onDelete(automation)}
          />
        </>
      }
      toggle={
        <AutomationLifecycleControl
          checked={automation.enabled}
          label={`${automation.enabled ? "Pause" : "Resume"} ${automation.name}`}
          onCheckedChange={(enabled) =>
            actions.onEnabledChange(automation, enabled)
          }
        />
      }
    />
  );
}

function AutomationProblemRow({
  automation,
  project,
  onNavigate,
}: {
  automation: AutomationReadProblem;
  project: OverviewEntry["project"];
  onNavigate: (
    route: AutomationDetailRoute,
    options?: AutomationDetailNavigationOptions,
  ) => void;
}) {
  const repairTarget =
    automation.problem === "missing-agent-prompt" ? automation : null;
  const problemLabel = automationProblemLabel(automation);
  const route = routeOf(automation);
  return (
    <ResourceRow
      leading={
        <Icon
          name={repairTarget !== null ? "AlertCircle" : "CircleX"}
          className={cn(
            repairTarget !== null ? "text-warning" : "text-destructive",
            COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
          )}
          aria-hidden
        />
      }
      title={automation.name}
      state={
        <span
          className={cn(
            "inline-flex shrink-0 self-center items-center whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium",
            repairTarget !== null
              ? "bg-warning/10 text-warning-text"
              : "bg-destructive/10 text-destructive-text",
          )}
        >
          {problemLabel}
        </span>
      }
      description={
        <AutomationRowMetadata automation={repairTarget} project={project} />
      }
      className="items-start"
      onOpen={() =>
        onNavigate(route, repairTarget === null ? undefined : { editing: true })
      }
      persistentActions={
        repairTarget !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNavigate(route, { editing: true })}
          >
            Edit
          </Button>
        ) : undefined
      }
    />
  );
}

function automationProblemLabel(automation: AutomationReadProblem): string {
  return automation.problem === "missing-agent-prompt"
    ? "Prompt required"
    : "Invalid data";
}

function automationProblemSearchText(
  automation: AutomationReadProblem,
): string {
  return automation.problem === "missing-agent-prompt"
    ? `${automationProblemLabel(automation)} needs prompt missing prompt`
    : `${automationProblemLabel(automation)} invalid stored data`;
}

function matchesAutomationReadStatusFilters(
  automation: OverviewEntry["automation"],
  statusFilters: readonly AutomationStatusFilter[],
): boolean {
  if ("problem" in automation && automation.problem === "invalid-stored-data") {
    return statusFilters.length === 0;
  }
  return matchesAutomationStatusFilters(automation, statusFilters);
}

function automationSearchValues(
  automation: OverviewEntry["automation"],
  projectName: string,
): string[] {
  const values = [automation.name, projectName, "Local"];
  if ("problem" in automation) {
    values.push(automationProblemSearchText(automation));
    if (automation.problem === "invalid-stored-data") return values;
  }
  values.push(formatScheduleStatusLabel(automation));
  values.push(formatAutomationTrigger(automation.trigger));
  return values;
}

function isActiveEntry({ automation }: OverviewEntry): boolean {
  return (
    "problem" in automation ||
    matchesAutomationStatusFilters(automation, ["active"])
  );
}

type ListItem = {
  name: string;
  nextRunAt: number | null;
  rank: number;
  priority: LoopPriority;
  node: ReactNode;
};

function sortByNextRun(
  items: readonly ListItem[],
  direction: AutomationSortDirection,
): ListItem[] {
  return [...items].sort((left, right) =>
    applyAutomationSortDirection(
      (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) -
        (right.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name),
      direction,
    ),
  );
}

function sortByName(
  items: readonly ListItem[],
  direction: AutomationSortDirection,
): ListItem[] {
  return [...items].sort(
    (left, right) =>
      left.rank - right.rank ||
      applyAutomationSortDirection(
        left.name.localeCompare(right.name),
        direction,
      ),
  );
}

function cloudLifecycleSortRank(automation: CloudAutomation): number {
  const once = automation.cron === null && !isCloudWebhook(automation);
  if (!automation.enabled) return once && automation.runs > 0 ? 3 : 2;
  return once ? 1 : 0;
}

function cloudNextRunAt(automation: CloudAutomation): number | null {
  return automation.next_run_at === null
    ? null
    : Date.parse(automation.next_run_at);
}

function NewLoopMenu({
  onCreateViaChat,
}: {
  onCreateViaChat: (prompt?: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          aria-label="New loop"
          className="ml-1 h-8 gap-1.5 px-2.5"
        >
          <Icon name="Plus" className="size-3.5" aria-hidden />
          New
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {NEW_LOOP_OPTIONS.map((option) => (
          <Fragment key={option.label}>
            {"divider" in option ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              className="items-start gap-2.5 py-2"
              onSelect={() => onCreateViaChat(option.prompt)}
            >
              <Icon name={option.icon} className="mt-0.5 size-4" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5">
                  {option.label}
                  {"isNew" in option ? (
                    <span className="rounded-sm bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                      New
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AutomationOverviewView({
  entries,
  error,
  onRetry,
  onOpenDetail,
  onEnabledChange,
  onCreateViaChat,
  activeMode,
  onModeChange,
  cloud,
  review,
  templates,
  localDialog,
}: {
  entries: OverviewEntry[] | null;
  error: string | null;
  onRetry: () => void;
  onOpenDetail: (
    route: AutomationDetailRoute,
    options?: AutomationDetailNavigationOptions,
  ) => void;
  onEnabledChange: (
    enabled: boolean,
    route: AutomationDetailRoute,
  ) => Promise<void>;
  onCreateViaChat: (prompt?: string) => void;
  activeMode: AutomationCollectionMode;
  onModeChange: (mode: AutomationCollectionMode) => void;
  cloud?: {
    rows: readonly CloudAutomation[];
    actions: CloudAutomationActions;
  };
  review?: LoopReviewState;
  templates?: LoopTemplatesState;
  localDialog?: {
    automationId: string;
    render: (
      priority: LoopPriority,
      onPriorityChange: (priority: LoopPriority) => void,
    ) => ReactNode;
  };
}) {
  const [query, setQuery] = useState("");
  const [reviewLayout, setReviewLayout] = useState<ReviewLayout>("list");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("to-review");
  const [projectFilters, setProjectFilters] = useState<
    AutomationProjectFilter[]
  >([]);
  const [statusFilters, setStatusFilters] = useState<AutomationStatusFilter[]>(
    [],
  );
  const [sortMode, setSortMode] = useState<AutomationSortMode>("next");
  const [sortDirection, setSortDirection] =
    useState<AutomationSortDirection>("asc");
  const { priorities, setPriority } = useLoopPriorities();
  const [openCloudId, setOpenCloudId] = useState<string | null>(null);
  const { providers } = useProviders();
  const now = useMinuteClock();

  const normalizedQuery = query.trim().toLowerCase();
  const projectCounts = useMemo(() => {
    const counts = new Map<AutomationProjectFilter, number>();
    for (const entry of entries ?? []) {
      const project = automationProjectFilterId(entry);
      counts.set(project, (counts.get(project) ?? 0) + 1);
    }
    return counts;
  }, [entries]);
  const projectBucketCount = projectCounts.size;
  const projectOptions = useMemo(() => {
    const options = new Map<AutomationProjectFilter, string>();
    for (const entry of entries ?? []) {
      options.set(
        automationProjectFilterId(entry),
        automationProjectLabel(entry.project),
      );
    }
    return [...options].map(([id, label]) => ({ id, label }));
  }, [entries]);
  useEffect(() => {
    setProjectFilters((current) =>
      current.filter((project) => projectCounts.has(project)),
    );
  }, [projectCounts]);
  useEffect(() => {
    if (sortMode === "project" && projectBucketCount <= 1) {
      setSortMode("next");
      setSortDirection("asc");
    }
  }, [projectBucketCount, sortMode]);
  const filteredEntries = useMemo(() => {
    if (entries === null) return [];
    return entries.filter((entry) => {
      const { automation, project } = entry;
      if (
        projectFilters.length > 0 &&
        !projectFilters.includes(automationProjectFilterId(entry))
      ) {
        return false;
      }
      if (!matchesAutomationReadStatusFilters(automation, statusFilters)) {
        return false;
      }
      return (
        normalizedQuery.length === 0 ||
        automationSearchValues(automation, project.name).some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        )
      );
    });
  }, [entries, normalizedQuery, projectFilters, statusFilters]);
  const visibleEntries = useMemo(() => {
    return [...filteredEntries].sort((left, right) => {
      if ("problem" in left.automation && "problem" in right.automation) {
        return applyAutomationSortDirection(
          left.automation.name.localeCompare(right.automation.name),
          sortDirection,
        );
      }
      if ("problem" in left.automation) return -1;
      if ("problem" in right.automation) return 1;
      const bothEnabled = left.automation.enabled && right.automation.enabled;
      const lifecycleOrder =
        automationLifecycleSortRank(left.automation) -
        automationLifecycleSortRank(right.automation);
      if (lifecycleOrder !== 0 && !(sortMode === "next" && bothEnabled)) {
        return lifecycleOrder;
      }
      const byName = left.automation.name.localeCompare(right.automation.name);
      const base =
        sortMode === "project"
          ? automationProjectLabel(left.project).localeCompare(
              automationProjectLabel(right.project),
            ) || byName
          : sortMode === "next"
            ? (left.automation.nextRunAt ?? Number.MAX_SAFE_INTEGER) -
                (right.automation.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
              byName
            : byName;
      return applyAutomationSortDirection(base, sortDirection);
    });
  }, [filteredEntries, sortDirection, sortMode]);
  const activeEntries = visibleEntries.filter(isActiveEntry);
  const inactiveEntries = visibleEntries.filter(
    (entry) => !isActiveEntry(entry),
  );
  const cloudRows = cloud?.rows ?? [];
  const openCloud = cloudRows.find((row) => row.id === openCloudId);
  const visibleCloud = cloudRows.filter(
    (automation) =>
      projectFilters.length === 0 &&
      (statusFilters.length === 0 ||
        statusFilters.includes(automation.enabled ? "active" : "paused")) &&
      (normalizedQuery === "" ||
        [automation.name, "Cloud"].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        )),
  );
  const handleSortChange = useCallback(
    (nextSort: string) => {
      if (
        nextSort !== "project" &&
        nextSort !== "alpha" &&
        nextSort !== "next"
      ) {
        return;
      }
      if (nextSort === "project" && projectBucketCount <= 1) return;
      if (nextSort === sortMode) {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
        return;
      }
      setSortMode(nextSort);
      setSortDirection("asc");
    },
    [projectBucketCount, sortMode],
  );

  let body: ReactNode;
  if (error !== null) {
    body = (
      <ResourceListState
        state="error"
        message="Couldn't load loops."
        onRetry={onRetry}
      />
    );
  } else if (entries === null) {
    body = (
      <DelayedLoading>
        <ResourceListState state="loading" message="Loading loops" />
      </DelayedLoading>
    );
  } else if (entries.length === 0 && cloudRows.length === 0) {
    body = <ResourceListState state="empty" message="No loops yet." />;
  } else if (visibleEntries.length === 0 && visibleCloud.length === 0) {
    body = (
      <ResourceListState
        state="empty"
        message={
          normalizedQuery === ""
            ? "No loops match these filters."
            : projectFilters.length > 0 || statusFilters.length > 0
              ? `No loops match "${query}" with these filters.`
              : `No loops match "${query}"`
        }
      />
    );
  } else {
    const needsYou = new Map<string, number>();
    for (const item of review?.data?.items ?? []) {
      if (item.status !== "needs-you" || item.reviewedAt !== null) continue;
      const key = item.loop.id ?? item.loop.name;
      needsYou.set(key, (needsYou.get(key) ?? 0) + 1);
    }
    const priorityOf = (key: string) =>
      priorities[key] ?? DEFAULT_LOOP_PRIORITY;
    const priorityMenu = (key: string, name: string) => (
      <LoopPriorityMenu
        priority={priorityOf(key)}
        name={name}
        onChange={(priority) => setPriority(key, priority)}
      />
    );
    const renderEntry = ({
      automation,
      project,
      scriptAgents,
    }: OverviewEntry) =>
      "problem" in automation ? (
        <AutomationProblemRow
          key={automation.id}
          automation={automation}
          project={project}
          onNavigate={onOpenDetail}
        />
      ) : (
        <OverviewRow
          key={automation.id}
          automation={automation}
          project={project}
          scriptAgents={scriptAgents}
          providers={providers}
          showProject={projectBucketCount > 1}
          now={now}
          needsYou={needsYou.get(automation.id) ?? 0}
          leading={priorityMenu(`local:${automation.id}`, automation.name)}
          onNavigate={onOpenDetail}
          onEnabledChange={onEnabledChange}
        />
      );
    const localItem = (entry: OverviewEntry): ListItem => ({
      name: entry.automation.name,
      nextRunAt:
        "problem" in entry.automation ? null : entry.automation.nextRunAt,
      rank:
        "problem" in entry.automation
          ? 0
          : automationLifecycleSortRank(entry.automation),
      priority: priorityOf(`local:${entry.automation.id}`),
      node: renderEntry(entry),
    });
    const cloudItem = (automation: CloudAutomation): ListItem => ({
      name: automation.name,
      nextRunAt: cloudNextRunAt(automation),
      rank: cloudLifecycleSortRank(automation),
      priority: priorityOf(`cloud:${automation.id}`),
      node: cloud ? (
        <CloudAutomationRow
          key={automation.id}
          automation={automation}
          providers={providers}
          now={now}
          needsYou={needsYou.get(automation.name) ?? 0}
          leading={priorityMenu(`cloud:${automation.id}`, automation.name)}
          actions={{
            ...cloud.actions,
            onOpen: (a) => setOpenCloudId(a.id),
          }}
        />
      ) : null,
    });
    const problems = activeEntries.filter(
      (entry) => "problem" in entry.automation,
    );
    const activeRest = [
      ...activeEntries
        .filter((entry) => !("problem" in entry.automation))
        .map(localItem),
      ...visibleCloud.filter((automation) => automation.enabled).map(cloudItem),
    ];
    const activeItems =
      sortMode === "next"
        ? sortByNextRun(activeRest, sortDirection)
        : sortMode === "alpha"
          ? sortByName(activeRest, sortDirection)
          : activeRest;
    const inactiveRest = [
      ...inactiveEntries.map(localItem),
      ...visibleCloud
        .filter((automation) => !automation.enabled)
        .map(cloudItem),
    ];
    const inactiveItems =
      sortMode === "alpha"
        ? sortByName(inactiveRest, sortDirection)
        : inactiveRest;
    const nextRunAt = Math.min(
      ...activeItems.flatMap((item) => item.nextRunAt ?? []),
    );
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const failedToday = (review?.data?.items ?? []).filter(
      (item) =>
        item.status === "failed" &&
        item.reviewedAt === null &&
        item.at >= startOfToday,
    ).length;
    const needsYouTotal = [...needsYou.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    body = (
      <div className="pb-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <LoopStat label="Active loops" value={activeItems.length} />
          <LoopStat
            label="Next run"
            value={
              Number.isFinite(nextRunAt) ? formatTimeUntil(nextRunAt, now) : "—"
            }
            className="font-mono"
          />
          <LoopStat
            label="Needs you"
            value={needsYouTotal}
            className={needsYouTotal > 0 ? "text-warning-text" : undefined}
            onClick={review ? () => onModeChange("review") : undefined}
          />
          <LoopStat
            label="Failed today"
            value={failedToday}
            className={failedToday > 0 ? "text-destructive-text" : undefined}
            onClick={review ? () => onModeChange("review") : undefined}
          />
        </div>
        {problems.length > 0 ? (
          <div className="mt-6 divide-y divide-foreground/10">
            {problems.map(renderEntry)}
          </div>
        ) : null}
        {activeItems.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
            No loops running.
          </div>
        ) : (
          <div className="mt-2">
            {LOOP_PRIORITIES.map((priority) => {
              const group = activeItems.filter(
                (item) => item.priority === priority,
              );
              if (group.length === 0) return null;
              return (
                <section key={priority} aria-label={`Priority ${priority}`}>
                  <LoopGroupDivider
                    label={`P${priority}`}
                    count={group.length}
                    className={LOOP_PRIORITY_STYLE[priority].text}
                  />
                  <div className="space-y-2.5">
                    {group.map((item) => item.node)}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {inactiveItems.length > 0 ? (
          <section aria-label="Off" className="mt-4">
            <LoopGroupDivider
              label="Off"
              count={inactiveItems.length}
              className="text-muted-foreground"
            />
            <div className="space-y-2.5">
              {inactiveItems.map((item) => item.node)}
            </div>
          </section>
        ) : null}
      </div>
    );
  }
  return (
    <ResourceCollectionPage
      id="automations-collection"
      description={
        entries !== null && entries.length + cloudRows.length === 0
          ? "Loops run agents and scripts on a schedule, locally or in the cloud, without you prompting each step."
          : undefined
      }
      underlineTabs
      bandClassName={
        activeMode === "installed" ? OVERVIEW_BAND_CLASSES : undefined
      }
      modes={[
        {
          id: "installed",
          label: "Overview",
          count:
            entries === null ? undefined : entries.length + cloudRows.length,
        },
        {
          id: "review",
          label: "Review",
          count: review?.data?.toReview || undefined,
        },
        { id: "templates", label: "Templates" },
      ]}
      activeMode={activeMode}
      onModeChange={onModeChange}
      actions={
        <>
          {activeMode === "installed" ? (
            <>
              <div className="relative w-44 sm:w-56">
                <Icon
                  name="Search"
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search loops"
                  aria-label="Search loops"
                  className="h-8 border-0 bg-muted/50 pl-8 text-sm"
                />
              </div>
              <ResourceFilterMenu
                compact
                quiet
                groups={[
                  {
                    id: "projects",
                    label: "Projects",
                    options: projectOptions,
                    selectedValues: projectFilters,
                    onChange: (values) =>
                      setProjectFilters(
                        values.filter(isAutomationProjectFilter),
                      ),
                  },
                  {
                    id: "status",
                    label: "Status",
                    options: AUTOMATION_STATUS_FILTER_OPTIONS,
                    selectedValues: statusFilters,
                    onChange: (values) =>
                      setStatusFilters(values.filter(isAutomationStatusFilter)),
                  },
                ]}
              />
              <ResourceSortMenu
                value={sortMode}
                direction={sortDirection}
                compact
                quiet
                options={[
                  { id: "next", label: "Next run" },
                  {
                    id: "project",
                    label: "Project",
                    disabled: projectBucketCount <= 1,
                  },
                  { id: "alpha", label: "Loop name" },
                ]}
                onChange={handleSortChange}
              />
            </>
          ) : activeMode === "review" && review ? (
            <ReviewToolbar
              layout={reviewLayout}
              filter={reviewFilter}
              markable={reviewableItems(review.data?.items ?? []).length}
              onLayoutChange={setReviewLayout}
              onFilterChange={setReviewFilter}
              onMarkAll={() =>
                review.onMark(
                  reviewableItems(review.data?.items ?? []).map(
                    (item) => item.id,
                  ),
                  true,
                )
              }
            />
          ) : null}
          <NewLoopMenu onCreateViaChat={onCreateViaChat} />
        </>
      }
    >
      {activeMode === "review" && review ? (
        <ResourceCollectionViewport scrollId="automations-review-results">
          <LoopReviewView
            review={review.data}
            error={review.error}
            layout={reviewLayout}
            filter={reviewFilter}
            now={now}
            onRetry={review.onRetry}
            onOpenThread={review.onOpenThread}
            onMark={review.onMark}
          />
        </ResourceCollectionViewport>
      ) : activeMode === "templates" && templates ? (
        <ResourceCollectionViewport scrollId="automations-templates">
          <LoopTemplatesView
            entries={entries}
            cloudRows={cloudRows}
            templates={{
              ...templates,
              onAdd: async (template, projectIds, target) => {
                const keys = await templates.onAdd(template, projectIds, target);
                for (const key of keys) setPriority(key, template.priority);
                return keys;
              },
            }}
            renderAgent={(agent) => (
              <AutomationAgentLine
                agents={[agent]}
                providers={providers}
                compact
              />
            )}
          />
        </ResourceCollectionViewport>
      ) : (
        <ResourceCollectionViewport scrollId="automations-installed-results">
          <div className={OVERVIEW_BAND_CLASSES}>{body}</div>
        </ResourceCollectionViewport>
      )}
      {openCloud && cloud ? (
        <CloudLoopDialog
          automation={openCloud}
          priority={
            priorities[`cloud:${openCloud.id}`] ?? DEFAULT_LOOP_PRIORITY
          }
          onPriorityChange={(priority) =>
            setPriority(`cloud:${openCloud.id}`, priority)
          }
          actions={cloud.actions}
          onClose={() => setOpenCloudId(null)}
        />
      ) : null}
      {localDialog
        ? localDialog.render(
            priorities[`local:${localDialog.automationId}`] ??
              DEFAULT_LOOP_PRIORITY,
            (priority) =>
              setPriority(`local:${localDialog.automationId}`, priority),
          )
        : null}
    </ResourceCollectionPage>
  );
}
