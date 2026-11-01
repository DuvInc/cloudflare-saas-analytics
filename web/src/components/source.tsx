import { Badge } from "@/components/ui/badge";

/** A channel, and the assistant when it is AI. */
export function Source({ channel, ai }: { channel?: string | null; ai?: string | null }) {
  if (!channel && !ai) return <span className="text-muted-foreground">Unknown</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">{channel}</span>
      {ai && <Badge variant="outline" className="border-info-border bg-info text-info-foreground">{ai}</Badge>}
    </span>
  );
}
