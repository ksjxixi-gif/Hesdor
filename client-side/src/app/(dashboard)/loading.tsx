import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return <div className="space-y-4 p-5 sm:p-8"><Skeleton className="h-8 w-52" /><Skeleton className="h-28 w-full" /><Skeleton className="h-72 w-full" /></div>;
}
