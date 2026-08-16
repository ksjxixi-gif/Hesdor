"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, BellRing, Clock3, DoorOpen, ListTodo, Radio, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { accessApi, announcementApi, attendanceApi, billingApi, employeeApi, getApiBaseUrl, conversationApi, organizationApi, taskApi } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-provider";
import { useRealtime } from "@/lib/signalr/realtime-provider";
import { Can } from "@/lib/permissions/permissions";

function metricValue(value: number | undefined) {
  return value === undefined ? "—" : value.toLocaleString();
}

export function OverviewScreen() {
  const { session, user } = useAuth();
  const realtime = useRealtime();
  const tenantQuery = useQuery({ queryKey: ["current-tenant"], queryFn: () => organizationApi.current(session!.accessToken), enabled: Boolean(session) });
  const employeesQuery = useQuery({ queryKey: ["employees", "overview"], queryFn: () => employeeApi.list(session!.accessToken, { page: 1, pageSize: 1 }), enabled: Boolean(session) });
  const presenceQuery = useQuery({ queryKey: ["presence", "overview"], queryFn: () => attendanceApi.presence(session!.accessToken), enabled: Boolean(session) });
  const accessQuery = useQuery({ queryKey: ["access-events", "overview"], queryFn: () => accessApi.events(session!.accessToken, 1, 5), enabled: Boolean(session) });
  const tasksQuery = useQuery({ queryKey: ["tasks", "overview"], queryFn: () => taskApi.list(session!.accessToken), enabled: Boolean(session) });
  const conversationsQuery = useQuery({ queryKey: ["conversations", "overview"], queryFn: () => conversationApi.list(session!.accessToken), enabled: Boolean(session) });
  const announcementsQuery = useQuery({ queryKey: ["announcements", "overview"], queryFn: () => announcementApi.list(session!.accessToken), enabled: Boolean(session) });
  const billingQuery = useQuery({ queryKey: ["billing", "current"], queryFn: () => billingApi.current(session!.accessToken), enabled: Boolean(session) });

  const inOfficeCount = presenceQuery.data?.filter(item => item.state === 0 || item.state === 2).length;
  const openTaskCount = tasksQuery.data?.filter(task => task.status !== 4 && task.status !== 5).length;
  const metrics = [
    { label: "Employees", value: metricValue(employeesQuery.data?.totalCount), note: employeesQuery.isError ? "Requires employees.read" : "Current organization roster", icon: Users, tone: "blue" as const },
    { label: "Currently on site", value: metricValue(inOfficeCount), note: presenceQuery.isError ? "Requires attendance.read" : "Live presence state", icon: Clock3, tone: "cyan" as const },
    { label: "Recent access events", value: metricValue(accessQuery.data?.totalCount), note: accessQuery.isError ? "Requires access policy permission" : "Most recent tenant events", icon: DoorOpen, tone: "cyan" as const },
    { label: "Open tasks", value: metricValue(openTaskCount), note: tasksQuery.isError ? "Requires tasks.read" : "Active work items", icon: ListTodo, tone: "blue" as const },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-8 sm:px-8 lg:px-10">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#00D4FF]">Command center</p><h1 className="mt-3 font-headline text-3xl font-semibold tracking-[-0.07em] text-[#E6E8EB] sm:text-4xl">Overview</h1><p className="mt-2 text-sm text-[#8C929C]">A live read on the people, places, and work that keep your company moving.</p></div><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#8C929C]"><span className={realtime.isConfigured ? "h-1.5 w-1.5 rounded-full bg-[#00D4FF]" : "h-1.5 w-1.5 rounded-full bg-[#59616C]"} />{realtime.isConfigured ? "Realtime configured" : "Realtime awaiting hub"}</div></div>

      <div className="mt-8 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{metrics.map((metric) => { const Icon = metric.icon; return <Card key={metric.label} className="p-5"><div className="flex items-start justify-between"><p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#8C929C]">{metric.label}</p><Icon size={17} className={metric.tone === "cyan" ? "text-[#00D4FF]" : "text-[#205BFF]"} /></div><p className="mt-7 font-headline text-2xl font-semibold tracking-[-0.06em] text-[#E6E8EB]">{metric.value}</p><p className="mt-2 text-xs leading-5 text-[#59616C]">{metric.note}</p></Card>; })}</div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <Card><CardHeader><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#00D4FF]">Organization</p><h2 className="mt-2 font-headline text-xl font-semibold tracking-[-0.05em] text-[#E6E8EB]">{tenantQuery.data?.name ?? "Workspace status"}</h2></div>{tenantQuery.data ? <Badge tone="cyan">{tenantQuery.data.status === 1 ? "Active" : "Trial"}</Badge> : <Badge tone="neutral">Loading</Badge>}</div></CardHeader><CardContent><div className="grid gap-4 sm:grid-cols-3"><div><p className="text-[10px] uppercase tracking-[0.16em] text-[#59616C]">Plan</p><p className="mt-2 text-sm font-semibold text-[#E6E8EB]">{billingQuery.data?.entitlements?.planCode ?? "—"}</p></div><div><p className="text-[10px] uppercase tracking-[0.16em] text-[#59616C]">Subscription</p><p className="mt-2 text-sm font-semibold text-[#E6E8EB]">{billingQuery.data?.subscription ? "Configured" : "—"}</p></div><div><p className="text-[10px] uppercase tracking-[0.16em] text-[#59616C]">Identity</p><p className="mt-2 truncate text-sm font-semibold text-[#E6E8EB]">{user?.email ?? "—"}</p></div></div><p className="mt-6 text-[10px] uppercase tracking-[0.16em] text-[#59616C]">API: {getApiBaseUrl()}</p></CardContent></Card>
        <Card><CardHeader><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#00D4FF]">Signals</p><h2 className="mt-2 font-headline text-xl font-semibold tracking-[-0.05em] text-[#E6E8EB]">Today’s pulse</h2></div><Radio size={17} className="text-[#00D4FF]" /></div></CardHeader><CardContent><div className="space-y-4"><div className="flex items-center justify-between border-b border-[#2A2E35] pb-4"><span className="text-xs text-[#8C929C]">Announcements</span><span className="text-sm font-semibold text-[#E6E8EB]">{metricValue(announcementsQuery.data?.length)}</span></div><div className="flex items-center justify-between border-b border-[#2A2E35] pb-4"><span className="text-xs text-[#8C929C]">Conversations</span><span className="text-sm font-semibold text-[#E6E8EB]">{metricValue(conversationsQuery.data?.length)}</span></div><div className="flex items-center justify-between"><span className="text-xs text-[#8C929C]">Unread counts</span><span className="text-[10px] uppercase tracking-[0.12em] text-[#59616C]">Read-state query next</span></div></div></CardContent></Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card><CardHeader><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#00D4FF]">Presence</p><h2 className="mt-2 font-headline text-xl font-semibold tracking-[-0.05em] text-[#E6E8EB]">Who is on site?</h2></div><Badge tone={presenceQuery.isError ? "danger" : "neutral"}>{presenceQuery.isError ? "Restricted" : "Live source"}</Badge></div></CardHeader><CardContent><EmptyState icon={Users} eyebrow="Presence stream" title={presenceQuery.data?.length ? `${presenceQuery.data.length} presence states loaded.` : "Presence starts with employees."} description={presenceQuery.data?.length ? "The live state is ready for a richer employee presence board." : "Create employees and record attendance or access events to populate this surface."} /></CardContent></Card>
        <Card><CardHeader><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#00D4FF]">Announcements</p><h2 className="mt-2 font-headline text-xl font-semibold tracking-[-0.05em] text-[#E6E8EB]">What changed?</h2></div><BellRing size={17} className="text-[#205BFF]" /></div></CardHeader><CardContent>{announcementsQuery.data?.length ? <div className="space-y-3">{announcementsQuery.data.slice(0, 3).map(item => <div key={item.id} className="border-b border-[#2A2E35] pb-3 last:border-0"><p className="text-sm font-semibold text-[#E6E8EB]">{item.title}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-[#8C929C]">{item.body}</p></div>)}</div> : <EmptyState icon={BellRing} eyebrow="Announcements" title="No announcements yet." description="Published company updates will appear here when the announcements contract is used." />}</CardContent></Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2"><Card><CardHeader><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#00D4FF]">Access</p><h2 className="mt-2 font-headline text-xl font-semibold tracking-[-0.05em] text-[#E6E8EB]">Recent access events</h2></div><DoorOpen size={17} className="text-[#00D4FF]" /></div></CardHeader><CardContent>{accessQuery.data?.items?.length ? <div className="space-y-3">{accessQuery.data.items.slice(0, 5).map(item => <div key={item.id} className="flex items-center justify-between border-b border-[#2A2E35] pb-3 last:border-0"><div className="flex items-center gap-3"><span className="h-2 w-2 rounded-full bg-[#00D4FF]" /><div><p className="text-sm font-semibold text-[#E6E8EB]">{item.reason}</p><p className="text-xs text-[#59616C]">{new Date(item.occurredAtUtc).toLocaleString()}</p></div></div><Badge tone={item.decision === 0 || item.decision === 6 ? "green" : "danger"}>{item.decision === 0 || item.decision === 6 ? "Granted" : "Denied"}</Badge></div>)}</div> : <EmptyState icon={DoorOpen} eyebrow="Access stream" title="No access events yet." description="Connect a controller or submit an edge event to see the access stream." />}</CardContent></Card><Card><CardHeader><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#00D4FF]">Audit</p><h2 className="mt-2 font-headline text-xl font-semibold tracking-[-0.05em] text-[#E6E8EB]">Recent activity</h2></div><Activity size={17} className="text-[#8C929C]" /></div></CardHeader><CardContent><Can permission="audit.read" fallback={<div className="border border-dashed border-[#2A2E35] bg-[#0B0D11] px-5 py-10 text-center text-sm text-[#8C929C]">You need <span className="font-semibold text-[#E6E8EB]">audit.read</span> to view organization activity.</div>}><EmptyState icon={Activity} eyebrow="Audit module" title="Audit query ready." description="The audit API is first-class and ready for a searchable activity surface." /></Can></CardContent></Card></div>
    </div>
  );
}
