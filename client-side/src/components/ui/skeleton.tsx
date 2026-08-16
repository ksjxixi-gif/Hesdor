import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-elevated", className)} />;
}

export function SkeletonRows({ rows = 5, height = "h-14" }: { rows?: number; height?: string }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className={cn("w-full", height)} />)}
    </div>
  );
}
