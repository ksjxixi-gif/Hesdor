import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "blue" | "cyan" | "green" | "amber" | "red" | "danger";

const tones: Record<BadgeTone, string> = {
  neutral: "border-border bg-elevated text-text-muted",
  blue: "border-accent/30 bg-accent-soft text-accent-ink",
  cyan: "border-cyan/30 bg-cyan/10 text-cyan",
  green: "border-green/30 bg-green-soft text-green",
  amber: "border-amber/30 bg-amber-soft text-amber",
  red: "border-red/30 bg-red-soft text-red",
  danger: "border-red/30 bg-red-soft text-red",
};

export function Badge({ className, tone = "neutral", ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold", tones[tone], className)} {...props} />;
}
