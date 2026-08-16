import type { LucideIcon } from "lucide-react";
import { BarChart3, Building2, CalendarClock, CheckSquare2, DoorOpen, Files, LayoutDashboard, MessageCircle, Settings2, ShieldCheck, Users } from "lucide-react";

export type NavigationItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

export const navigationGroups: { label: string; items: NavigationItem[] }[] = [
  {
    label: "Operate",
    items: [
      { label: "Overview", href: "/overview", icon: LayoutDashboard },
      { label: "People", href: "/people", icon: Users },
      { label: "Organization", href: "/organization", icon: Building2 },
      { label: "Access", href: "/access", icon: DoorOpen },
      { label: "Attendance", href: "/attendance", icon: CalendarClock },
    ],
  },
  {
    label: "Coordinate",
    items: [
      { label: "Work", href: "/work", icon: CheckSquare2 },
      { label: "Messages", href: "/messages", icon: MessageCircle },
      { label: "Files", href: "/files", icon: Files },
    ],
  },
  {
    label: "Govern",
    items: [
      { label: "Reports", href: "/reports", icon: BarChart3 },
      { label: "Audit", href: "/audit", icon: ShieldCheck },
      { label: "Settings", href: "/settings", icon: Settings2 },
    ],
  },
];

export const allNavigationItems = navigationGroups.flatMap((group) => group.items);
