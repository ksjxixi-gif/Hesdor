import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EmptyState({ icon: Icon, eyebrow, title, description, actionLabel, onAction }: { icon: LucideIcon; eyebrow?: string; title: string; description: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong bg-bg/60 px-6 py-12 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-accent/25 bg-accent-soft text-accent">
        <Icon size={20} />
      </div>
      {eyebrow ? <p className="mt-5 text-[11px] font-bold uppercase tracking-[0.2em] text-accent">{eyebrow}</p> : null}
      <h3 className="mt-2 font-headline text-lg font-semibold text-text">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-text-muted">{description}</p>
      {actionLabel && onAction ? <Button className="mt-6" onClick={onAction}>{actionLabel}</Button> : null}
    </div>
  );
}
