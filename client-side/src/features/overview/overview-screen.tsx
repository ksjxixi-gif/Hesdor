"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, BellRing, Clock3, DoorOpen, ListTodo, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader, SectionHeading } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { Avatar } from "@/components/shared/avatar";
import { accessApi, announcementApi, attendanceApi, billingApi, employeeApi, conversationApi, organizationApi, taskApi } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-provider";
import { useRealtime } from "@/lib/signalr/realtime-provider";
import { Can } from "@/lib/permissions/permissions";
import { formatDateTime, timeAgo } from "@/lib/utils";

export function OverviewScreen() {
  const { session, user } = useAuth();
  const realtime = useRealtime();
  const token = session?.accessToken ?? "";

  const tenantQuery = useQuery({ queryKey: ["current-tenant"], queryFn: () => organizationApi.current(token), enabled: Boolean(session) });
  const employeesQuery = useQuery({ queryKey: ["employees", "overview"], queryFn: () => employeeApi.list(token, { page: 1, pageSize: 50 }), enabled: Boolean(session) });
  const presenceQuery = useQuery({ queryKey: ["presence", "overview"], queryFn: () => attendanceApi.presence(token), enabled: Boolean(session) });
  const accessQuery = useQuery({ queryKey: ["access-events", "overview"], queryFn: () => accessApi.events(token, 1, 8), enabled: Boolean(session) });
  const tasksQuery = useQuery({ queryKey: ["tasks", "overview"], queryFn: () => taskApi.list(token), enabled: Boolean(session) });
  const conversationsQuery = useQuery({ queryKey: ["conversations", "overview"], queryFn: () => conversationApi.list(token), enabled: Boolean(session) });
  const announcementsQuery = useQuery({ queryKey: ["announcements", "overview"], queryFn: () => announcementApi.list(token), enabled: Boolean(session) });
  const billingQuery = useQuery({ queryKey: ["billing", "current"], queryFn: () => billingApi.current(token), enabled: Boolean(session) });

  const employeeNameById = new Map(
    (employeesQuery.data?.items ?? []).map((employee) => [
      employee.id ?? "",
      [employee.firstName, employee.lastName].filter(Boolean).join(" ") || employee.email || "Unknown",
    ]),
  );

  const onSite = presenceQuery.data?.filter((item) => item.state === 0 || item.state === 2) ?? [];
  const openTaskCount = tasksQuery.data?.filter((task) => task.status !== 4 && task.status !== 5).length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        eyebrow="Command center"
        title={`Good to see you${user?.email ? `, ${user.email.split("@")[0]}` : ""}`}
        description={`${tenantQuery.data?.name ?? "Your workspace"} — live people, access, and work.`}
        actions={
          <Badge tone={realtime.isConfigured ? "green" : "neutral"}>
            <span className={`live-dot h-1.5 w-1.5 rounded-full ${realtime.isConfigured ? "bg-green" : "bg-text-faint"}`} />
            {realtime.isConfigured ? "Live" : "Offline"}
          </Badge>
        }
      />

      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Users} label="Employees" value={employeesQuery.data?.totalCount ?? "—"} note={employeesQuery.isError ? "Requires employees.read" : "Roster size"} />
        <StatCard icon={Clock3} label="On site now" value={onSite.length} tone="cyan" note={presenceQuery.isError ? "Requires attendance.read" : "Live presence"} />
        <StatCard icon={DoorOpen} label="Access events" value={accessQuery.data?.totalCount ?? "—"} tone="green" note={accessQuery.isError ? "Requires access permissions" : "Total recorded"} />
        <StatCard icon={ListTodo} label="Open tasks" value={openTaskCount ?? "—"} tone="amber" note={tasksQuery.isError ? "Requires tasks.read" : "Across all projects"} />
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader>
            <SectionHeading eyebrow="Presence" title="Who's on site" action={<Badge tone="cyan">{onSite.length} present</Badge>} />
          </CardHeader>
          <CardContent>
            {onSite.length ? (
              <div className="divide-y divide-border">
                {onSite.slice(0, 6).map((presence) => {
                  const name = employeeNameById.get(presence.employeeId) ?? "Unknown employee";
                  return (
                    <div key={presence.employeeId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                      <Avatar name={name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-text">{name}</p>
                        <p className="text-xs text-text-faint">Updated {timeAgo(presence.updatedAtUtc)}</p>
                      </div>
                      <Badge tone="green"><span className="live-dot h-1.5 w-1.5 rounded-full bg-green" /> On site</Badge>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState icon={Users} title="Nobody on site yet" description="Presence fills in as employees badge in or clock in from attendance." />
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <SectionHeading eyebrow="Access" title="Recent door events" action={<DoorOpen size={16} className="text-cyan" />} />
          </CardHeader>
          <CardContent>
            {accessQuery.data?.items?.length ? (
              <div className="divide-y divide-border">
                {accessQuery.data.items.map((event) => (
                  <div key={event.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text">{event.reason.replaceAll("_", " ")}</p>
                      <p className="text-xs text-text-faint">{formatDateTime(event.occurredAtUtc)}</p>
                    </div>
                    <Badge tone={event.decision === 0 || event.decision === 6 ? "green" : "red"}>
                      {event.decision === 0 || event.decision === 6 ? "Granted" : "Denied"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon={DoorOpen} title="No access events yet" description="Events appear as doors and edge agents start reporting." />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <SectionHeading eyebrow="Workspace" title="Plan & billing" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-muted">Plan</span>
              <Badge tone="blue">{billingQuery.data?.entitlements?.planCode ?? "—"}</Badge>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
              <span className="text-sm text-text-muted">Renews</span>
              <span className="tnum text-sm font-semibold text-text">{formatDateTime(billingQuery.data?.subscription?.currentPeriodEndUtc)}</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
              <span className="text-sm text-text-muted">Conversations</span>
              <span className="tnum text-sm font-semibold text-text">{conversationsQuery.data?.length ?? "—"}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <SectionHeading eyebrow="Announcements" title="What changed" action={<BellRing size={16} className="text-accent" />} />
          </CardHeader>
          <CardContent>
            {announcementsQuery.data?.length ? (
              <div className="space-y-4">
                {announcementsQuery.data.slice(0, 3).map((announcement) => (
                  <div key={announcement.id} className="border-l-2 border-accent/40 pl-4">
                    <p className="text-sm font-semibold text-text">{announcement.title}</p>
                    <p className="mt-1 line-clamp-2 text-sm leading-6 text-text-muted">{announcement.body}</p>
                    <p className="mt-1 text-xs text-text-faint">{timeAgo(announcement.publishedAtUtc ?? announcement.createdAtUtc)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon={BellRing} title="No announcements yet" description="Company updates published in messaging will show here." />
            )}
          </CardContent>
        </Card>
      </div>

      <Can permission="audit.read">
        <div className="mt-5">
          <Card>
            <CardHeader>
              <SectionHeading eyebrow="Audit" title="Activity stream" action={<Activity size={16} className="text-text-faint" />} />
            </CardHeader>
            <CardContent>
              <EmptyState icon={Activity} title="Audit module ready" description="Organization activity appears here once the audit feed endpoint is wired to the UI." />
            </CardContent>
          </Card>
        </div>
      </Can>
    </div>
  );
}
