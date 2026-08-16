"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { AuthFrame } from "@/features/auth/auth-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  return (
    <AuthFrame eyebrow="Account recovery" title="Recover access." description="Enter your work email and Hesdor will use the organization’s configured recovery policy.">
      {submitted ? <div className="border border-[#00D4FF]/30 bg-[#00D4FF]/10 p-4 text-sm leading-6 text-[#B9F2FF]">The recovery request was captured. Email delivery will activate when the backend recovery contract is enabled.</div> : <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); setSubmitted(true); }}><div><label htmlFor="recovery-email" className="mb-2 block text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C929C]">Work email</label><Input id="recovery-email" type="email" required placeholder="you@company.com" /></div><Button type="submit" className="w-full"><Mail size={15} /> Request recovery</Button></form>}
    </AuthFrame>
  );
}
