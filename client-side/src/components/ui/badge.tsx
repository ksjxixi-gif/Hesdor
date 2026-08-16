import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Badge({ className, tone = "neutral", ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "blue" | "cyan" | "green" | "danger" }) {
  const tones = {
    neutral: "border-[#2A2E35] bg-[#0B0D11] text-[#8C929C]",
    blue: "border-[#205BFF]/40 bg-[#205BFF]/10 text-[#6E96FF]",
    cyan: "border-[#00D4FF]/35 bg-[#00D4FF]/10 text-[#61E7FF]",
    green: "border-[#28B77B]/35 bg-[#28B77B]/10 text-[#6CE0AD]",
    danger: "border-[#743D46] bg-[#291B22] text-[#FFB4BA]",
  };

  return <span className={cn("inline-flex items-center border px-2 py-1 text-[9px] font-bold uppercase tracking-[0.16em]", tones[tone], className)} {...props} />;
}
