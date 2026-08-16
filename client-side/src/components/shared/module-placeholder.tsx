"use client";

import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Can, type PermissionCode } from "@/lib/permissions/permissions";

export function ModulePlaceholder({ icon, eyebrow, title, description, permission, recordsLabel, filters = true }: { icon: LucideIcon; eyebrow: string; title: string; description: string; permission: PermissionCode; recordsLabel: string; filters?: boolean }) {
  return (
    <div className="mx-auto max-w-[1320px] px-5 py-8 sm:px-8 lg:px-10">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#00D4FF]">{eyebrow}</p><h1 className="mt-3 font-headline text-3xl font-semibold tracking-[-0.07em] text-[#E6E8EB]">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#8C929C]">{description}</p></div><Can permission={permission}><Badge tone="blue">{permission}</Badge></Can></div>
      <Card className="mt-8"><CardContent><div className="flex flex-col gap-3 border-b border-[#2A2E35] pb-5 sm:flex-row"><div className="relative flex-1">{filters ? <><Search size={15} className="absolute left-3 top-3 text-[#59616C]" /><Input className="pl-9" placeholder={`Search ${recordsLabel.toLowerCase()}`} disabled /></> : null}</div><div className="border border-[#2A2E35] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#59616C]">Filters coming with data</div></div><div className="pt-5"><EmptyState icon={icon} eyebrow={`${eyebrow} module`} title={`No ${recordsLabel.toLowerCase()} yet.`} description="This surface is ready for the API contract. It will include loading, filtering, empty, permission, and error states without inventing operational data." /></div></CardContent></Card>
    </div>
  );
}
