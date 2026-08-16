"use client";

import { Bell, Command, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth/auth-provider";
import { useRealtime } from "@/lib/signalr/realtime-provider";
import { Button } from "@/components/ui/button";
import { BrandLockup } from "@/components/shared/brand-lockup";

export function Topbar() {
  const { user, logout } = useAuth();
  const { isConfigured } = useRealtime();
  const initials = (user?.email?.slice(0, 2) ?? "HS").toUpperCase();

  return (
    <header className="flex min-h-[72px] items-center justify-between border-b border-[#2A2E35] bg-[#0B0D11] px-5 sm:px-8">
      <div className="lg:hidden"><BrandLockup compact /></div>
      <div className="hidden items-center gap-3 lg:flex">
        <button type="button" className="flex h-10 min-w-[240px] items-center gap-3 border border-[#2A2E35] bg-[#14171C] px-3 text-left text-xs text-[#59616C] transition hover:border-[#205BFF]"><Command size={15} /> Search workspace <span className="ml-auto border border-[#2A2E35] px-1.5 py-0.5 text-[9px] text-[#59616C]">⌘ K</span></button>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden items-center gap-2 text-[9px] font-bold uppercase tracking-[0.18em] text-[#8C929C] sm:flex"><span className={isConfigured ? "h-1.5 w-1.5 rounded-full bg-[#00D4FF]" : "h-1.5 w-1.5 rounded-full bg-[#59616C]"} />{isConfigured ? "Realtime ready" : "Realtime offline"}</div>
        <button type="button" aria-label="Notifications" className="grid h-9 w-9 place-items-center border border-transparent text-[#8C929C] transition hover:border-[#2A2E35] hover:bg-[#14171C] hover:text-[#E6E8EB]"><Bell size={16} /></button>
        <div className="grid h-9 w-9 place-items-center border border-[#2A2E35] bg-[#14171C] text-[10px] font-bold text-[#00D4FF]">{initials}</div>
        <Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={logout}><LogOut size={14} /> Sign out</Button>
      </div>
    </header>
  );
}
