"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, ShieldCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { roleApi } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-provider";

export function OrganizationScreen() {
  const { session } = useAuth();
  const rolesQuery = useQuery({ queryKey: ["roles"], queryFn: () => roleApi.list(session!.accessToken), enabled: Boolean(session) });
  const permissionsQuery = useQuery({ queryKey: ["permissions"], queryFn: () => roleApi.permissions(session!.accessToken), enabled: Boolean(session) });
  return <div className="mx-auto max-w-[1320px] px-5 py-8 sm:px-8 lg:px-10"><div><p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#00D4FF]">Organization</p><h1 className="mt-3 font-headline text-3xl font-semibold tracking-[-0.07em] text-[#E6E8EB]">Company structure</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#8C929C]">Departments, teams, roles, and permissions remain one connected model instead of disconnected admin screens.</p></div><div className="mt-8 grid gap-4 xl:grid-cols-3"><Card><CardHeader><Building2 size={17} className="text-[#00D4FF]" /><h2 className="mt-4 font-headline text-xl font-semibold text-[#E6E8EB]">Departments and teams</h2></CardHeader><CardContent><EmptyState icon={Users} eyebrow="Organization contract" title="Structure is ready for data." description="Department and team CRUD will attach to the employee directory without inventing hierarchy levels." /></CardContent></Card><Card><CardHeader><ShieldCheck size={17} className="text-[#205BFF]" /><h2 className="mt-4 font-headline text-xl font-semibold text-[#E6E8EB]">Roles</h2></CardHeader><CardContent>{rolesQuery.data?.length ? <div className="space-y-3">{rolesQuery.data.map(role => <div key={role.id} className="flex items-center justify-between border-b border-[#2A2E35] pb-3 last:border-0"><div><p className="text-sm font-semibold text-[#E6E8EB]">{role.name}</p><p className="mt-1 text-xs text-[#59616C]">{role.permissions.length} permission rules</p></div>{role.isSystemRole ? <Badge tone="blue">System</Badge> : <Badge>Custom</Badge>}</div>)}</div> : <EmptyState icon={ShieldCheck} eyebrow="Authorization" title="No role data yet." description="The roles API is ready for the first owner bootstrap." />}</CardContent></Card><Card><CardHeader><ShieldCheck size={17} className="text-[#00D4FF]" /><h2 className="mt-4 font-headline text-xl font-semibold text-[#E6E8EB]">Permission catalog</h2></CardHeader><CardContent>{permissionsQuery.data?.length ? <div className="flex flex-wrap gap-2">{permissionsQuery.data.slice(0, 12).map(permission => <Badge key={permission.id} tone="neutral">{permission.code}</Badge>)}</div> : <p className="text-sm leading-6 text-[#8C929C]">Canonical permissions are seeded during the first organization bootstrap.</p>}</CardContent></Card></div></div>;
}
