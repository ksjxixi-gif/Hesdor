"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Search, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Input } from "@/components/ui/input";
import { ApiError, employeeApi } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-provider";
import { Can } from "@/lib/permissions/permissions";

export function PeopleScreen() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const query = useQuery({ queryKey: ["employees", search], queryFn: () => employeeApi.list(session!.accessToken, { search, page: 1, pageSize: 50 }), enabled: Boolean(session) });
  const createMutation = useMutation({ mutationFn: (body: { firstName: string; lastName: string; employeeNumber: string; jobTitle: string }) => employeeApi.create(session!.accessToken, body), onSuccess: () => { setShowCreate(false); queryClient.invalidateQueries({ queryKey: ["employees"] }); } });

  const items = query.data?.items ?? [];
  const accessError = query.error instanceof ApiError && query.error.status === 403;

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-8 sm:px-8 lg:px-10">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#00D4FF]">People</p><h1 className="mt-3 font-headline text-3xl font-semibold tracking-[-0.07em] text-[#E6E8EB]">Employees</h1><p className="mt-2 text-sm text-[#8C929C]">The identity root for access, attendance, work, files, and permissions.</p></div><Can permission="employees.manage"><Button onClick={() => setShowCreate(value => !value)}><Plus size={15} /> Add employee</Button></Can></div>
      {showCreate ? <Card className="mt-6"><CardContent><form className="grid gap-3 md:grid-cols-4" onSubmit={(event) => { event.preventDefault(); const formData = new FormData(event.currentTarget); createMutation.mutate({ firstName: String(formData.get("firstName")), lastName: String(formData.get("lastName")), employeeNumber: String(formData.get("employeeNumber")), jobTitle: String(formData.get("jobTitle")) }); }}><Input name="firstName" placeholder="First name" required /><Input name="lastName" placeholder="Last name" required /><Input name="employeeNumber" placeholder="Employee number" required /><Input name="jobTitle" placeholder="Job title" required /><Button className="md:col-span-4" type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? <><Loader2 size={15} className="animate-spin" /> Creating</> : "Create employee"}</Button></form>{createMutation.error ? <p className="mt-3 text-xs text-[#FFB4BA]">{createMutation.error instanceof Error ? createMutation.error.message : "Employee could not be created."}</p> : null}</CardContent></Card> : null}
      <Card className="mt-8"><CardContent><div className="relative mb-5"><Search size={15} className="absolute left-3 top-3 text-[#59616C]" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employees" className="pl-9" /></div>{query.isPending ? <div className="space-y-3"><div className="h-12 animate-pulse bg-[#2A2E35]" /><div className="h-12 animate-pulse bg-[#2A2E35]" /></div> : accessError ? <EmptyState icon={Users} eyebrow="Permission required" title="Employee directory is restricted." description="Ask an administrator for employees.read to view this workspace." /> : query.error ? <EmptyState icon={Users} eyebrow="API error" title="Employee data could not load." description={query.error instanceof Error ? query.error.message : "Try the request again."} /> : items.length === 0 ? <EmptyState icon={Users} eyebrow="People module" title="No employees yet." description="Create the first employee to start the organization, presence, and access loop." /> : <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left"><thead><tr className="border-b border-[#2A2E35] text-[10px] uppercase tracking-[0.16em] text-[#59616C]"><th className="px-3 py-3 font-semibold">Employee</th><th className="px-3 py-3 font-semibold">Number</th><th className="px-3 py-3 font-semibold">Role</th><th className="px-3 py-3 font-semibold">Status</th></tr></thead><tbody>{items.map((employee) => <tr key={employee.id} className="border-b border-[#2A2E35] last:border-0"><td className="px-3 py-4"><p className="text-sm font-semibold text-[#E6E8EB]">{employee.firstName} {employee.lastName}</p><p className="mt-1 text-xs text-[#59616C]">{employee.email ?? "No login identity"}</p></td><td className="px-3 py-4 text-xs text-[#8C929C]">{employee.employeeNumber}</td><td className="px-3 py-4 text-xs text-[#8C929C]">{employee.jobTitle}</td><td className="px-3 py-4"><Badge tone={employee.employmentStatus === 1 ? "green" : "neutral"}>{employee.employmentStatus === 1 ? "Active" : "Inactive"}</Badge></td></tr>)}</tbody></table></div>}</CardContent></Card>
    </div>
  );
}
