"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { allNavigationItems } from "@/components/layout/navigation";
import { cn } from "@/lib/utils";

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1.5 overflow-x-auto border-b border-border bg-bg px-4 py-2.5 lg:hidden">
      {allNavigationItems.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              active ? "bg-accent-soft text-accent-ink" : "text-text-muted hover:bg-elevated",
            )}
          >
            <Icon size={14} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
