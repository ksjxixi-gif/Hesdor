"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { BrandLockup } from "@/components/shared/brand-lockup";
import { navigationGroups } from "@/components/layout/navigation";
import { useAuth } from "@/lib/auth/auth-provider";
import { useTenant } from "@/lib/tenant/tenant-provider";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const pathname = usePathname();
  const { logout } = useAuth();
  const { tenant } = useTenant();

  return (
    <aside className="hidden w-[250px] shrink-0 flex-col border-r border-[#2A2E35] bg-[#0B0D11] px-4 py-5 lg:flex">
      <Link href="/overview" className="px-3"><BrandLockup compact /></Link>
      <div className="mt-10 border-y border-[#2A2E35] px-3 py-4">
        <p className="text-[9px] font-bold uppercase tracking-[0.24em] text-[#59616C]">Hesdor workspace</p>
        <p className="mt-2 truncate text-xs font-semibold text-[#8C929C]">{tenant?.name ?? "Workplace infrastructure"}</p>
      </div>
      <nav className="mt-7 flex-1 space-y-6 overflow-y-auto">
        {navigationGroups.map((group) => (
          <div key={group.label}>
            <p className="mb-2 px-3 text-[9px] font-bold uppercase tracking-[0.22em] text-[#59616C]">{group.label}</p>
            <div className="space-y-1">
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} className={cn("group flex items-center gap-3 border px-3 py-2.5 text-xs transition", active ? "border-[#2A2E35] bg-[#14171C] font-semibold text-[#E6E8EB]" : "border-transparent text-[#8C929C] hover:border-[#2A2E35] hover:bg-[#14171C] hover:text-[#E6E8EB]")}>
                    <Icon size={16} className={active ? "text-[#00D4FF]" : "text-[#59616C] group-hover:text-[#8C929C]"} />
                    <span>{item.label}</span>
                    {active ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#205BFF] shadow-[0_0_10px_3px_rgba(32,91,255,0.45)]" /> : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <button type="button" onClick={logout} className="mt-5 flex items-center gap-3 border border-transparent px-3 py-2.5 text-left text-xs text-[#59616C] transition hover:border-[#743D46] hover:bg-[#291B22] hover:text-[#FFB4BA]"><LogOut size={16} /> Sign out</button>
    </aside>
  );
}
