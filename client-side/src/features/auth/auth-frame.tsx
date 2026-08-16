import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { BrandLockup } from "@/components/shared/brand-lockup";

export function AuthFrame({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-[#0B0D11] px-5 py-8 text-[#E6E8EB] sm:px-8">
      <div className="mx-auto max-w-[1160px]">
        <Link href="/" className="inline-flex"><BrandLockup /></Link>
        <div className="mx-auto mt-20 grid max-w-[980px] gap-10 lg:grid-cols-[0.82fr_0.58fr] lg:items-center">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#00D4FF]">{eyebrow}</p>
            <h1 className="mt-4 max-w-xl font-headline text-5xl font-extrabold leading-[0.98] tracking-[-0.075em] text-[#E6E8EB]">{title}</h1>
            <p className="mt-6 max-w-md text-base leading-7 text-[#8C929C]">{description}</p>
            <Link href="/" className="mt-10 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#8C929C] transition hover:text-[#E6E8EB]"><ArrowLeft size={14} /> Back to Hesdor</Link>
          </div>
          <div className="border border-[#2A2E35] bg-[#14171C] p-6 sm:p-8">{children}</div>
        </div>
      </div>
    </main>
  );
}
