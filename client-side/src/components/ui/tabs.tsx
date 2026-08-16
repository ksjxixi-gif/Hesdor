"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-elevated/60 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={cn(
            "rounded-md px-3.5 py-1.5 text-sm font-semibold transition",
            value === tab.value ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text",
          )}
        >
          {tab.label}
          {tab.count !== undefined ? <span className={cn("tnum ml-1.5 text-xs", value === tab.value ? "text-accent" : "text-text-faint")}>{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ value, current, children }: { value: string; current: string; children: ReactNode }) {
  if (value !== current) return null;
  return <>{children}</>;
}
