"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return <div className="mx-auto max-w-xl p-8"><div className="border border-[#743D46] bg-[#291B22] p-7"><AlertTriangle className="text-[#FFB4BA]" /><h2 className="mt-4 font-headline text-xl font-semibold text-[#E6E8EB]">Something interrupted this workspace.</h2><p className="mt-2 text-sm leading-6 text-[#D49AA1]">Try the request again. If it keeps happening, check the API status.</p><Button className="mt-6" variant="destructive" onClick={reset}>Try again</Button></div></div>;
}
