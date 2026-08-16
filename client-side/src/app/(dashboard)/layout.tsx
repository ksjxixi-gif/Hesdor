import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { DashboardGuard } from "@/features/auth/dashboard-guard";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardGuard><AppShell>{children}</AppShell></DashboardGuard>;
}
