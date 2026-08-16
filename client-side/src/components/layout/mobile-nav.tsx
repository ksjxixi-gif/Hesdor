"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { allNavigationItems } from "@/components/layout/navigation";
import { cn } from "@/lib/utils";

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-2 overflow-x-auto border-b border-[#2A2E35] bg-[#0B0D11] px-5 py-3 lg:hidden">
      {allNavigationItems.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        return <Link key={item.href} href={item.href} className={cn("flex shrink-0 items-center gap-2 border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em]", active ? "border-[#205BFF]/50 bg-[#205BFF]/10 text-[#61E7FF]" : "border-[#2A2E35] text-[#8C929C]")}><Icon size={13} />{item.label}</Link>;
      })}
    </nav>
  );
}
