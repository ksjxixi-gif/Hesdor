import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col justify-between gap-4 sm:flex-row sm:items-end", className)}>
      <div>
        {eyebrow ? <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-accent">{eyebrow}</p> : null}
        <h1 className="mt-1.5 font-headline text-3xl font-semibold tracking-tight text-text">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionHeading({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        {eyebrow ? <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-accent">{eyebrow}</p> : null}
        <h2 className="mt-1 font-headline text-lg font-semibold text-text">{title}</h2>
      </div>
      {action}
    </div>
  );
}
