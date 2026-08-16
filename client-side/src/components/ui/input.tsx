import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full border border-[#2A2E35] bg-[#0B0D11] px-3 text-sm text-[#E6E8EB] outline-none transition placeholder:text-[#59616C] focus:border-[#205BFF] focus:ring-4 focus:ring-[#205BFF]/15",
        className,
      )}
      {...props}
    />
  );
});
