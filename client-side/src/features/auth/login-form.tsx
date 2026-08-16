"use client";

import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { authApi, ApiError } from "@/lib/api/client";
import { saveSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const loginSchema = z.object({
  email: z.string().email("Enter a valid work email."),
  password: z.string().min(1, "Enter your password."),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();
  const form = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });
  const mutation = useMutation({
    mutationFn: ({ email, password }: LoginValues) => authApi.login(email, password),
    onSuccess: (session) => {
      saveSession(session);
      router.replace("/overview");
    },
  });
  const apiMessage = mutation.error instanceof ApiError ? mutation.error.message : mutation.error ? "The API could not complete the sign in." : null;

  return (
    <form className="space-y-5" onSubmit={form.handleSubmit((values) => mutation.mutate(values))} noValidate>
      <div>
        <label htmlFor="email" className="mb-2 block text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C929C]">Work email</label>
        <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" aria-invalid={Boolean(form.formState.errors.email)} {...form.register("email")} />
        {form.formState.errors.email ? <p className="mt-2 text-xs text-[#FFB4BA]">{form.formState.errors.email.message}</p> : null}
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between"><label htmlFor="password" className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C929C]">Password</label><Link href="/forgot-password" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#5C8AFF] hover:text-[#61E7FF]">Forgot password</Link></div>
        <Input id="password" type="password" autoComplete="current-password" placeholder="Enter your password" aria-invalid={Boolean(form.formState.errors.password)} {...form.register("password")} />
        {form.formState.errors.password ? <p className="mt-2 text-xs text-[#FFB4BA]">{form.formState.errors.password.message}</p> : null}
      </div>
      {apiMessage ? <div role="alert" className="flex gap-2 border border-[#743D46] bg-[#291B22] px-3 py-3 text-xs leading-5 text-[#FFB4BA]"><AlertCircle size={16} className="mt-0.5 shrink-0" />{apiMessage}</div> : null}
      <Button type="submit" className="w-full" disabled={mutation.isPending}>{mutation.isPending ? <><Loader2 size={15} className="animate-spin" /> Signing in</> : <>Sign in <ArrowRight size={15} /></>}</Button>
      <p className="text-center text-[11px] leading-5 text-[#59616C]">Your session is scoped to your organization. Sensitive actions are audit logged.</p>
    </form>
  );
}
