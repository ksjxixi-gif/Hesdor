import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary: "bg-accent px-4 py-2.5 text-white shadow-sm hover:brightness-110 dark:hover:brightness-125",
        secondary: "border border-border bg-surface px-4 py-2.5 text-text hover:bg-elevated hover:border-border-strong",
        outline: "border border-border px-4 py-2.5 text-text-muted hover:border-border-strong hover:text-text",
        ghost: "px-3 py-2 text-text-muted hover:bg-elevated hover:text-text",
        destructive: "border border-red/30 bg-red-soft px-4 py-2.5 text-red hover:border-red/50",
      },
      size: {
        sm: "min-h-8 px-3 py-1.5 text-xs",
        md: "min-h-10",
        lg: "min-h-12 px-5 text-base",
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
