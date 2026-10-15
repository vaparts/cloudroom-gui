import { useMutation } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

async function askForMoreUsage() {
  const response = await fetchWithAppSurface("/api/v1/cloudroom/account/more-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const value = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(value?.message ?? `The request for more usage failed (HTTP ${response.status}).`);
}

export function CloudUsageLimitNotice() {
  const ask = useMutation({ mutationFn: askForMoreUsage });
  const free = Boolean(useCloudroomAccount().data?.planUsage);
  if (free) {
    return (
      <PromptStackCard ariaLabel="Cloud usage limit" className="space-y-2 p-3 text-xs">
        <p className="text-sm font-medium">You hit the Free plan's cloud limit.</p>
        <p className="text-muted-foreground">Your messages are saved, and Local threads still work. Pro gives you 10× more cloud agents and no daily limit.</p>
        <Button type="button" size="sm" onClick={() => openUrlInExternalBrowser("https://www.cloudroom.dev/billing")}>
          Upgrade to Pro<span className="font-normal opacity-70">$50/mo</span><Icon name="ArrowRight" aria-hidden />
        </Button>
      </PromptStackCard>
    );
  }
  return (
    <PromptStackCard ariaLabel="Cloud usage limit" className="space-y-2 p-3 text-xs">
      <p className="text-sm font-medium">You hit your plan's cloud limit.</p>
      <p className="text-muted-foreground">Your messages are saved, and Local threads still work. Older usage stops counting after 30 days.</p>
      {ask.isSuccess
        ? <p role="status" className="text-muted-foreground">Sent. The Cloudroom team will reach out to set up a quick call.</p>
        : <Button type="button" size="sm" disabled={ask.isPending} onClick={() => ask.mutate()}>Ask for more usage</Button>}
      {ask.error && <p role="alert" className="text-destructive">{ask.error.message}</p>}
    </PromptStackCard>
  );
}

/** A Free sandbox's 10 GB disk filled up: the moment to upgrade (ADR 0206). */
export function CloudDiskFullNotice() {
  return (
    <PromptStackCard ariaLabel="Cloud disk full" className="space-y-2 p-3 text-xs">
      <p className="text-sm font-medium">This cloud sandbox is out of disk space.</p>
      <p className="text-muted-foreground">Free sandboxes have 10 GB. Pro and Ultra get 20 GB and twice the CPU and memory for every new thread.</p>
      <Button type="button" size="sm" onClick={() => openUrlInExternalBrowser("https://www.cloudroom.dev/billing")}>Upgrade</Button>
    </PromptStackCard>
  );
}
