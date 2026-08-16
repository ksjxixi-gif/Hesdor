import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  icon: Icon,
  label,
  value,
  note,
  tone = "accent",
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  note?: string;
  tone?: "accent" | "cyan" | "green" | "amber";
}) {
  const toneClass = { accent: "text-accent", cyan: "text-cyan", green: "text-green", amber: "text-amber" }[tone];
  return (
    <Card className="rise p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs font-semibold text-text-muted">{label}</p>
        <div className={cn("rounded-lg border border-border bg-elevated p-1.5", toneClass)}>
          <Icon size={16} />
        </div>
      </div>
      <p className="tnum mt-4 font-headline text-3xl font-semibold tracking-tight text-text">{value}</p>
      {note ? <p className="mt-1.5 text-xs leading-5 text-text-faint">{note}</p> : null}
    </Card>
  );
}
