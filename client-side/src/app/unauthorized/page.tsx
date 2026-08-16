import Link from "next/link";
import { ShieldAlert } from "lucide-react";

export default function UnauthorizedPage() {
  return <main className="grid min-h-screen place-items-center bg-[#0B0D11] px-6 text-center text-[#E6E8EB]"><div className="max-w-md border border-[#2A2E35] bg-[#14171C] p-8"><ShieldAlert className="mx-auto text-[#00D4FF]" /><p className="mt-5 text-[10px] font-bold uppercase tracking-[0.22em] text-[#00D4FF]">Authentication required</p><h1 className="mt-2 font-headline text-2xl font-semibold tracking-[-0.05em]">Sign in to continue.</h1><Link href="/login" className="mt-6 inline-flex bg-gradient-to-r from-[#205BFF] to-[#00A9E8] px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-white">Go to sign in</Link></div></main>;
}
