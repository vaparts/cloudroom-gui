import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { PROMPT_STACK_CARD_HEADER_BUTTON_CLASS, PromptStackCard, PromptStackCardChevron } from "@/components/promptbox/banner/PromptStackCard";
import { useCloudroomAccount, type CloudDisk } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { openUpgrade, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

async function askForMoreUsage() {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/more-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const value = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(value?.message ?? `The request for more usage failed (HTTP ${response.status}).`);
}

export function CloudUsageLimitNotice() {
  const ask = useMutation({ mutationFn: askForMoreUsage });
  const plan = useCloudroomAccount().data?.planUsage?.plan;
  useUpgradePromptViewed(plan === "free" || plan === "pro" ? "limit_notice" : null);
  if (plan === "free") {
    return (
      <PromptStackCard ariaLabel="Cloud usage limit" className="space-y-2 p-3 text-xs">
        <p className="text-sm font-medium">You hit the Free plan's cloud limit.</p>
        <p className="text-muted-foreground">Your messages are saved, and Local threads still work. Pro gives you 10× more cloud agents and no daily limit.</p>
        <Button type="button" size="sm" onClick={() => openUpgrade("limit_notice")}>
          Upgrade to Pro<span className="font-normal opacity-70">$50/mo</span><Icon name="ArrowRight" aria-hidden />
        </Button>
      </PromptStackCard>
    );
  }
  return (
    <PromptStackCard ariaLabel="Cloud usage limit" className="space-y-2 p-3 text-xs">
      <p className="text-sm font-medium">You hit your plan's cloud limit.</p>
      <p className="text-muted-foreground">Your messages are saved, and Local threads still work. {plan === "pro" ? "Super gives you 3× more cloud agents and compute." : "Older usage stops counting after 30 days."}</p>
      <div className="flex flex-wrap items-center gap-2">
        {plan === "pro" && (
          <Button type="button" size="sm" onClick={() => openUpgrade("limit_notice")}>
            Upgrade to Super<span className="font-normal opacity-70">$150/mo</span><Icon name="ArrowRight" aria-hidden />
          </Button>
        )}
        {ask.isSuccess
          ? <p role="status" className="text-muted-foreground">Sent. The Cloudroom team will reach out to set up a quick call.</p>
          : <Button type="button" size="sm" variant={plan === "pro" ? "outline" : "default"} disabled={ask.isPending} onClick={() => ask.mutate()}>Ask for more usage</Button>}
      </div>
      {ask.error && <p role="alert" className="text-destructive">{ask.error.message}</p>}
    </PromptStackCard>
  );
}

const gb = (bytes: number) => Number((bytes / 1e9).toFixed(1));

/** A full cloud disk: one live card instead of a chat row per pause and resume. Free sandboxes also get the upgrade (ADR 0206). */
export function CloudDiskNotice({ disk }: { disk: CloudDisk }) {
  const [open, setOpen] = useState(false);
  useUpgradePromptViewed(disk.upgrade ? "disk_full" : null);
  const measured = disk.reason === "disk_capacity";
  const total = measured && disk.usedBytes !== null && disk.totalBytes ? disk.totalBytes : null;
  return (
    <PromptStackCard ariaLabel="Cloud disk full" className="overflow-hidden border-attention/50 text-xs">
      <div className="flex items-center">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn(PROMPT_STACK_CARD_HEADER_BUTTON_CLASS, "gap-2")}>
          <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-warning-text" aria-hidden />
          <span className="shrink-0 font-medium">{measured ? "Cloud disk full" : "Can't check cloud disk"}</span>
          <span className="min-w-0 truncate text-muted-foreground">{!measured ? "Work is paused until disk space can be measured" : disk.paused ? "Work is paused until space frees up" : "Work resumed, but space is still low"}</span>
          {total !== null && (
            <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
              <span className="h-1 w-[72px] overflow-hidden rounded-full bg-foreground/10">
                <span className="block h-full rounded-full bg-warning" style={{ width: `${Math.min(100, (disk.usedBytes ?? 0) / total * 100)}%` }} />
              </span>
              {gb(disk.usedBytes ?? 0)} / {gb(total)} GB
            </span>
          )}
          <PromptStackCardChevron isExpanded={open} className={cn("text-muted-foreground", total === null && "ml-auto")} />
        </button>
        {disk.upgrade && <Button type="button" size="sm" className="mr-2 h-6 px-2" onClick={() => openUpgrade("disk_full")}>Upgrade</Button>}
      </div>
      {open && (
        <p className="px-3 pb-2.5 text-muted-foreground">
          {measured ? "Cloudroom stops the command filling the disk within 30 seconds, then work resumes. Then ask the agent to delete what it no longer needs, like build output, caches, or node_modules." : "Your files and history are kept. Work resumes once the disk can be checked again."}
          {disk.upgrade && " Free sandboxes have 10 GB. Pro and Ultra get 20 GB and twice the CPU and memory for every new thread."}
        </p>
      )}
    </PromptStackCard>
  );
}
