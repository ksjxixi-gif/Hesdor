import Link from "next/link";
import { LockKeyhole } from "lucide-react";

export default function ForbiddenPage() {
  return <main className="grid min-h-screen place-items-center bg-[#0B0D11] px-6 text-center text-[#E6E8EB]"><div className="max-w-md border border-[#743D46] bg-[#291B22] p-8"><LockKeyhole className="mx-auto text-[#FFB4BA]" /><p className="mt-5 text-[10px] font-bold uppercase tracking-[0.22em] text-[#FFB4BA]">Permission denied</p><h1 className="mt-2 font-headline text-2xl font-semibold tracking-[-0.05em]">This action is restricted.</h1><p className="mt-3 text-sm leading-6 text-[#D49AA1]">Ask an organization administrator for the required permission.</p><Link href="/overview" className="mt-6 inline-flex border border-[#743D46] px-4 py-3 text-xs font-bold uppercase tracking-[0.14em] text-[#FFB4BA]">Return to overview</Link></div></main>;
}
