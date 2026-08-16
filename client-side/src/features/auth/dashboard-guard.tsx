"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-provider";
import { Skeleton } from "@/components/ui/skeleton";

export function DashboardGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, isLoading, sessionExpired } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const reason = sessionExpired ? "expired" : "required";
      router.replace(`/login?reason=${reason}&next=${encodeURIComponent(pathname)}`);
    }
  }, [isAuthenticated, isLoading, pathname, router, sessionExpired]);

  if (isLoading || !isAuthenticated) {
    return <main className="min-h-screen bg-[#0B0D11] p-6"><Skeleton className="h-10 w-48" /><Skeleton className="mt-8 h-32 w-full" /></main>;
  }

  return children;
}
