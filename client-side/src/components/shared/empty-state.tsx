import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EmptyState({ icon: Icon, eyebrow, title, description, actionLabel, onAction }: { icon: LucideIcon; eyebrow: string; title: string; description: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="border border-dashed border-[#2A2E35] bg-[#0B0D11] px-6 py-12 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center border border-[#205BFF]/35 bg-[#205BFF]/10 text-[#00D4FF]"><Icon size={20} /></div>
      <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.22em] text-[#00D4FF]">{eyebrow}</p>
      <h3 className="mt-2 font-headline text-lg font-semibold tracking-[-0.04em] text-[#E6E8EB]">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#8C929C]">{description}</p>
      {actionLabel && onAction ? <Button className="mt-6" onClick={onAction}>{actionLabel}</Button> : null}
    </div>
  );
}
