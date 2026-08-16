"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckSquare2, FolderKanban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { projectApi, taskApi } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-provider";

const taskStatus: Record<number, string> = { 0: "Backlog", 1: "Todo", 2: "In progress", 3: "Blocked", 4: "Done", 5: "Cancelled" };

export function WorkScreen() {
  const { session } = useAuth();
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list(session!.accessToken), enabled: Boolean(session) });
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: () => taskApi.list(session!.accessToken), enabled: Boolean(session) });
  return <div className="mx-auto max-w-[1320px] px-5 py-8 sm:px-8 lg:px-10"><div><p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#00D4FF]">Work</p><h1 className="mt-3 font-headline text-3xl font-semibold tracking-[-0.07em] text-[#E6E8EB]">Projects and tasks</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#8C929C]">A focused work layer that stays close to the people, operations, and permissions around it.</p></div><div className="mt-8 grid gap-4 xl:grid-cols-[0.7fr_1.3fr]"><Card><CardHeader><div className="flex items-center justify-between"><h2 className="font-headline text-xl font-semibold text-[#E6E8EB]">Projects</h2><FolderKanban size={17} className="text-[#00D4FF]" /></div></CardHeader><CardContent>{projectsQuery.data?.length ? <div className="space-y-2">{projectsQuery.data.map(project => <div key={project.id} className="border border-[#2A2E35] bg-[#0B0D11] p-4"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-[#E6E8EB]">{project.name}</p><Badge tone={project.status === 0 ? "cyan" : "neutral"}>{project.status === 0 ? "Active" : project.status === 1 ? "Completed" : "Archived"}</Badge></div>{project.description ? <p className="mt-2 text-xs leading-5 text-[#8C929C]">{project.description}</p> : null}</div>)}</div> : <EmptyState icon={FolderKanban} eyebrow="Projects" title="No projects yet." description="Create a project to give task activity a durable home." />}</CardContent></Card><Card><CardHeader><div className="flex items-center justify-between"><h2 className="font-headline text-xl font-semibold text-[#E6E8EB]">Task queue</h2><CheckSquare2 size={17} className="text-[#205BFF]" /></div></CardHeader><CardContent>{tasksQuery.data?.length ? <div className="space-y-2">{tasksQuery.data.map(task => <div key={task.id} className="flex items-center justify-between border-b border-[#2A2E35] pb-3 last:border-0"><div><p className="text-sm font-semibold text-[#E6E8EB]">{task.title}</p><p className="mt-1 text-xs text-[#59616C]">{task.dueAtUtc ? `Due ${new Date(task.dueAtUtc).toLocaleDateString()}` : "No due date"}</p></div><Badge tone={task.priority === 3 ? "danger" : task.status === 4 ? "green" : "neutral"}>{taskStatus[task.status] ?? "Unknown"}</Badge></div>)}</div> : <EmptyState icon={CheckSquare2} eyebrow="Tasks" title="No tasks yet." description="Tasks will stay intentionally smaller than ClickUp: status, priority, assignees, comments, and activity." />}</CardContent></Card></div></div>;
}
