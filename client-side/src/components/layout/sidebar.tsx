"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, LogOut } from "lucide-react";
import { BrandLockup } from "@/components/shared/brand-lockup";
import { navigationGroups } from "@/components/layout/navigation";
import { useAuth } from "@/lib/auth/auth-provider";
import { useTenant } from "@/lib/tenant/tenant-provider";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { tenant } = useTenant();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-bg px-3 py-5 lg:flex">
      <Link href="/overview" className="px-2"><BrandLockup compact /></Link>

      <div className="mt-8 rounded-lg border border-border bg-surface px-3 py-2.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-faint">Workspace</p>
        <p className="mt-1 truncate text-xs font-semibold text-text">{tenant?.name ?? "…"}</p>
      </div>

      <nav className="mt-6 flex-1 space-y-5 overflow-y-auto">
        {navigationGroups.map((group) => (
          <div key={group.label}>
            <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-text-faint">{group.label}</p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition",
                      active ? "bg-accent-soft text-accent-ink" : "text-text-muted hover:bg-elevated hover:text-text",
                    )}
                  >
                    {active ? <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" /> : null}
                    <Icon size={16} className={active ? "text-accent" : "text-text-faint"} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}

        {user?.isPlatform ? (
          <div>
            <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-text-faint">Platform</p>
            <Link
              href="/plans"
              className={cn(
                "relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition",
                pathname.startsWith("/plans") ? "bg-accent-soft text-accent-ink" : "text-text-muted hover:bg-elevated hover:text-text",
              )}
            >
              {pathname.startsWith("/plans") ? <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" /> : null}
              <LayoutGrid size={16} className={pathname.startsWith("/plans") ? "text-accent" : "text-text-faint"} />
              <span>Plans</span>
            </Link>
          </div>
        ) : null}
      </nav>

      <button type="button" onClick={logout} className="mt-4 flex items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-text-faint transition hover:bg-red-soft hover:text-red">
        <LogOut size={16} /> Sign out
      </button>
    </aside>
  );
}
