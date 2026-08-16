import Link from "next/link";
import { AuthFrame } from "@/features/auth/auth-frame";
import { LoginForm } from "@/features/auth/login-form";

export default function LoginPage() {
  return (
    <AuthFrame eyebrow="Workspace access" title="Enter Hesdor." description="Sign in to the operating layer for your company. Identity, organization, and audit are already wired for the next module.">
      <div className="mb-8"><p className="text-[10px] font-bold uppercase tracking-[0.24em] text-[#00D4FF]">Secure sign in</p><h2 className="mt-2 font-headline text-2xl font-semibold tracking-[-0.05em] text-[#E6E8EB]">Welcome back.</h2></div>
      <LoginForm />
      <div className="mt-7 border-t border-[#2A2E35] pt-5 text-center text-[10px] uppercase tracking-[0.14em] text-[#59616C]">Hesdor · Workplace Infrastructure</div>
      <Link href="/" className="sr-only">Return to landing page</Link>
    </AuthFrame>
  );
}
