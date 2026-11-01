import { cn } from "@/lib/utils";

/** Three rising bars in a frame, in the current text colour. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("size-6 shrink-0", className)}>
      <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7" y="12.5" width="2.5" height="5" rx="1.25" fill="currentColor" />
      <rect x="10.75" y="9.5" width="2.5" height="8" rx="1.25" fill="currentColor" />
      <rect x="14.5" y="6.5" width="2.5" height="11" rx="1.25" fill="currentColor" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <a href="#/" className={cn("flex items-center gap-2 rounded-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}>
      <Mark />
      <span className="text-[0.9375rem] font-semibold tracking-tight">SaaS Analytics</span>
    </a>
  );
}
