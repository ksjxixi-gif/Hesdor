import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-xs font-semibold uppercase tracking-[0.14em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#205BFF] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-gradient-to-r from-[#205BFF] to-[#00A9E8] px-4 py-3 text-white hover:brightness-110",
        secondary: "border border-[#2A2E35] bg-[#14171C] px-4 py-3 text-[#E6E8EB] hover:border-[#205BFF]",
        outline: "border border-[#2A2E35] px-4 py-3 text-[#8C929C] hover:border-[#00D4FF] hover:text-[#E6E8EB]",
        ghost: "px-3 py-2 text-[#8C929C] hover:bg-[#14171C] hover:text-[#E6E8EB]",
        destructive: "border border-[#743D46] bg-[#291B22] px-4 py-3 text-[#FFB4BA] hover:border-[#FF6D7A]",
      },
      size: {
        sm: "min-h-9",
        md: "min-h-11",
        lg: "min-h-13",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export function Button({ className, variant, size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
