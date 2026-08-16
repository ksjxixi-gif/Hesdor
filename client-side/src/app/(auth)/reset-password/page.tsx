"use client";

import { useState } from "react";
import { LockKeyhole } from "lucide-react";
import { AuthFrame } from "@/features/auth/auth-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ResetPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  return (
    <AuthFrame eyebrow="Account recovery" title="Set a new password." description="Choose a strong password for your Hesdor identity. The reset token will be validated by the API when that contract is enabled.">
      {submitted ? <div className="border border-[#00D4FF]/30 bg-[#00D4FF]/10 p-4 text-sm leading-6 text-[#B9F2FF]">Password reset is waiting for the backend recovery endpoint.</div> : <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); setSubmitted(true); }}><div><label htmlFor="new-password" className="mb-2 block text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C929C]">New password</label><Input id="new-password" type="password" required minLength={8} /></div><div><label htmlFor="confirm-password" className="mb-2 block text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C929C]">Confirm password</label><Input id="confirm-password" type="password" required minLength={8} /></div><Button type="submit" className="w-full"><LockKeyhole size={15} /> Update password</Button></form>}
    </AuthFrame>
  );
}
