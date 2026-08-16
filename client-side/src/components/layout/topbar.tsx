"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, LogOut, Moon, Sun } from "lucide-react";
import { useAuth } from "@/lib/auth/auth-provider";
import { useRealtime } from "@/lib/signalr/realtime-provider";
import { useTheme } from "@/lib/theme/theme-provider";
import { Avatar } from "@/components/shared/avatar";
import { BrandLockup } from "@/components/shared/brand-lockup";
import { cn } from "@/lib/utils";

export function Topbar() {
  const { user, logout } = useAuth();
  const { isConfigured } = useRealtime();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-border bg-bg/80 px-4 backdrop-blur-md sm:px-6">
      <div className="lg:hidden"><BrandLockup compact /></div>
      <div className="hidden lg:block" />

      <div className="flex items-center gap-1.5">
        <div className="mr-2 hidden items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-muted sm:flex">
          <span className={cn("live-dot h-1.5 w-1.5 rounded-full", isConfigured ? "bg-green" : "bg-text-faint")} />
          {isConfigured ? "Realtime" : "Offline"}
        </div>

        <button
          type="button"
          onClick={toggle}
          aria-label="Toggle theme"
          className="grid h-9 w-9 place-items-center rounded-lg text-text-muted transition hover:bg-elevated hover:text-text"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        <button type="button" aria-label="Notifications" className="grid h-9 w-9 place-items-center rounded-lg text-text-muted transition hover:bg-elevated hover:text-text">
          <Bell size={16} />
        </button>

        <div className="relative" ref={menuRef}>
          <button type="button" onClick={() => setMenuOpen((open) => !open)} className="flex items-center gap-2 rounded-lg p-1 transition hover:bg-elevated">
            <Avatar name={user?.email ?? "Hesdor"} />
          </button>
          {menuOpen ? (
            <div className="rise absolute right-0 top-11 w-56 rounded-xl border border-border bg-surface p-1.5 shadow-lg">
              <div className="border-b border-border px-3 py-2.5">
                <p className="truncate text-sm font-semibold text-text">{user?.email ?? "Signed in"}</p>
                <p className="mt-0.5 text-xs text-text-faint">{user?.roles.join(", ") || "Member"}</p>
              </div>
              <button
                type="button"
                onClick={logout}
                className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-text-muted transition hover:bg-red-soft hover:text-red"
              >
                <LogOut size={15} /> Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
