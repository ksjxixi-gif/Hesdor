import Link from "next/link";
import { ArrowRight, BadgeCheck, BarChart3, CheckSquare2, Clock3, DoorOpen, Files, MessageCircle, ShieldCheck, Users } from "lucide-react";
import { BrandLockup } from "@/components/shared/brand-lockup";

const modules = [
  { title: "Physical access", copy: "Doors, zones, credentials, and events in one operational layer.", icon: DoorOpen, tone: "cyan" },
  { title: "People & identity", copy: "Every employee, role, manager, and lifecycle state connected.", icon: Users, tone: "blue" },
  { title: "Attendance", copy: "Presence and time with the context of where work actually happens.", icon: Clock3, tone: "cyan" },
  { title: "Work", copy: "Projects and tasks that stay close to the people doing the work.", icon: CheckSquare2, tone: "blue" },
  { title: "Communication", copy: "Channels and conversations scoped to the organization.", icon: MessageCircle, tone: "cyan" },
  { title: "Files & audit", copy: "Company records and sensitive actions with a durable trail.", icon: Files, tone: "blue" },
];

function ProductPreview() {
  return (
    <div className="relative border border-[#2A2E35] bg-[#14171C] p-3 shadow-[0_28px_80px_rgba(0,0,0,0.4)] sm:p-5">
      <div className="absolute -right-3 -top-3 h-24 w-24 border-r border-t border-[#205BFF]/60" />
      <div className="flex items-center justify-between border-b border-[#2A2E35] pb-4">
        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#00D4FF]" /><span className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8C929C]">Hesdor command center</span></div>
        <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#59616C]">Live view</span>
      </div>
      <div className="grid grid-cols-2 gap-2 py-4 sm:grid-cols-4">
        {["Sites", "Employees", "Attendance", "Open tasks"].map((label, index) => <div key={label} className="border border-[#2A2E35] bg-[#0B0D11] p-3"><p className="text-[9px] uppercase tracking-[0.14em] text-[#59616C]">{label}</p><p className="mt-3 font-headline text-xl font-semibold text-[#E6E8EB]">{index === 2 ? "—" : "0"}</p><p className="mt-1 text-[9px] text-[#00D4FF]">Awaiting data</p></div>)}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1.2fr_0.8fr]">
        <div className="border border-[#2A2E35] bg-[#0B0D11] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8C929C]">Activity stream</p><BarChart3 size={15} className="text-[#205BFF]" /></div><div className="mt-5 h-20 border-b border-l border-[#2A2E35] bg-[linear-gradient(rgba(42,46,53,0.25)_1px,transparent_1px)] bg-[size:100%_20px] p-2"><svg className="h-full w-full" viewBox="0 0 460 72" preserveAspectRatio="none" fill="none"><path d="M0 63 56 59 120 62 178 42 238 49 305 28 370 36 460 10" stroke="#205BFF" strokeWidth="2" strokeDasharray="5 7" /><path d="M0 63 56 59 120 62 178 42 238 49 305 28 370 36 460 10" stroke="#00D4FF" strokeWidth="1" opacity="0.45" /></svg></div></div>
        <div className="border border-[#2A2E35] bg-[#0B0D11] p-4"><div className="flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8C929C]">Access relay</p><DoorOpen size={15} className="text-[#00D4FF]" /></div><div className="mt-6 flex items-center gap-3"><span className="grid h-9 w-9 place-items-center border border-[#00D4FF]/30 bg-[#00D4FF]/10 text-[#00D4FF]"><BadgeCheck size={17} /></span><div><p className="text-sm font-semibold text-[#E6E8EB]">Ready</p><p className="text-[10px] text-[#8C929C]">Offline-capable edge</p></div></div></div>
      </div>
    </div>
  );
}

export function LandingPage() {
  return (
    <main className="overflow-hidden bg-[#0B0D11] text-[#E6E8EB]">
      <header className="sticky top-0 z-20 border-b border-[#2A2E35]/80 bg-[#0B0D11]/95 backdrop-blur">
        <div className="mx-auto flex h-[76px] max-w-[1280px] items-center justify-between px-5 sm:px-8">
          <Link href="/"><BrandLockup /></Link>
          <nav className="hidden items-center gap-7 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8C929C] lg:flex"><a href="#platform" className="transition hover:text-[#E6E8EB]">Platform</a><a href="#modules" className="transition hover:text-[#E6E8EB]">Modules</a><a href="#security" className="transition hover:text-[#E6E8EB]">Security</a><a href="#company" className="transition hover:text-[#E6E8EB]">Company</a></nav>
          <div className="flex items-center gap-2"><Link href="/login" className="hidden px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#8C929C] hover:text-[#E6E8EB] sm:block">Sign in</Link><Link href="/login" className="inline-flex items-center gap-2 bg-gradient-to-r from-[#205BFF] to-[#00A9E8] px-3.5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white">Get started <ArrowRight size={14} /></Link></div>
        </div>
      </header>

      <section id="platform" className="relative border-b border-[#2A2E35] px-5 pb-24 pt-20 sm:px-8 sm:pt-28">
        <div className="absolute left-1/2 top-0 h-[520px] w-[820px] -translate-x-1/2 rounded-full border border-[#205BFF]/10" />
        <div className="relative mx-auto grid max-w-[1280px] items-center gap-16 lg:grid-cols-[0.88fr_1.12fr]">
          <div className="max-w-2xl"><p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#00D4FF]">Workplace infrastructure</p><h1 className="mt-6 font-headline text-5xl font-extrabold leading-[0.95] tracking-[-0.085em] sm:text-7xl">One system for the <span className="bg-gradient-to-r from-[#205BFF] to-[#00D4FF] bg-clip-text text-transparent">whole workplace.</span></h1><p className="mt-7 max-w-xl text-base leading-7 text-[#8C929C] sm:text-lg">Hesdor unifies physical access, employee identity, attendance, work, communication, and company operations into one engineered operating layer.</p><div className="mt-9 flex flex-wrap items-center gap-3"><Link href="/login" className="inline-flex items-center gap-2 bg-gradient-to-r from-[#205BFF] to-[#00A9E8] px-5 py-3 text-xs font-bold uppercase tracking-[0.14em] text-white">Enter Hesdor <ArrowRight size={15} /></Link><a href="#modules" className="border border-[#2A2E35] px-5 py-3 text-xs font-bold uppercase tracking-[0.14em] text-[#8C929C] hover:border-[#00D4FF] hover:text-[#E6E8EB]">Explore platform</a></div><div className="mt-10 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#59616C]"><span className="h-1.5 w-1.5 rounded-full bg-[#00D4FF] shadow-[0_0_10px_3px_rgba(0,212,255,0.28)]" />Designed for the physical world</div></div>
          <ProductPreview />
        </div>
      </section>

      <section id="modules" className="mx-auto max-w-[1280px] px-5 py-24 sm:px-8"><div className="max-w-xl"><p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#00D4FF]">A connected operating layer</p><h2 className="mt-5 font-headline text-4xl font-semibold tracking-[-0.07em] sm:text-5xl">Every workplace signal, in context.</h2><p className="mt-5 text-base leading-7 text-[#8C929C]">Stop stitching together systems that do not know each other. Hesdor gives teams one place to see, decide, and act.</p></div><div className="mt-14 grid gap-px border border-[#2A2E35] bg-[#2A2E35] md:grid-cols-2 xl:grid-cols-3">{modules.map((module) => { const Icon = module.icon; return <article key={module.title} className="group bg-[#0B0D11] p-7 transition hover:bg-[#14171C]"><div className={module.tone === "cyan" ? "grid h-10 w-10 place-items-center border border-[#00D4FF]/30 bg-[#00D4FF]/10 text-[#00D4FF]" : "grid h-10 w-10 place-items-center border border-[#205BFF]/35 bg-[#205BFF]/10 text-[#6E96FF]"}><Icon size={18} /></div><h3 className="mt-8 font-headline text-xl font-semibold tracking-[-0.05em] text-[#E6E8EB]">{module.title}</h3><p className="mt-3 text-sm leading-6 text-[#8C929C]">{module.copy}</p><span className="mt-8 inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[#59616C] transition group-hover:text-[#00D4FF]">Built into one system <ArrowRight size={13} /></span></article>; })}</div></section>

      <section id="security" className="border-y border-[#2A2E35] bg-[#14171C] px-5 py-24 sm:px-8"><div className="mx-auto grid max-w-[1280px] gap-14 lg:grid-cols-[0.8fr_1.2fr] lg:items-center"><div><p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#00D4FF]">Engineered for trust</p><h2 className="mt-5 font-headline text-4xl font-semibold tracking-[-0.07em] sm:text-5xl">Authoritative by default.</h2><p className="mt-5 max-w-md text-base leading-7 text-[#8C929C]">Tenant isolation, granular permissions, offline-capable access, and a durable audit trail are not add-ons. They are the foundation.</p></div><div className="grid gap-3 sm:grid-cols-3">{[{title:"Identity root", icon:Users, copy:"Employees anchor the operating model."},{title:"Policy composition", icon:ShieldCheck, copy:"Roles, overrides, and explicit denies."},{title:"Durable history", icon:BarChart3, copy:"Every sensitive action remains legible."}].map((item) => { const Icon = item.icon; return <div key={item.title} className="border border-[#2A2E35] bg-[#0B0D11] p-5"><Icon size={18} className="text-[#00D4FF]" /><p className="mt-8 text-sm font-semibold text-[#E6E8EB]">{item.title}</p><p className="mt-2 text-xs leading-5 text-[#8C929C]">{item.copy}</p></div>; })}</div></div></section>

      <section id="company" className="px-5 py-24 text-center sm:px-8"><p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#00D4FF]">The next layer starts here</p><h2 className="mx-auto mt-5 max-w-3xl font-headline text-4xl font-semibold tracking-[-0.08em] sm:text-6xl">Make the workplace <span className="text-[#8C929C]">legible.</span></h2><p className="mx-auto mt-6 max-w-xl text-base leading-7 text-[#8C929C]">Start with the foundation. Grow into access, attendance, work, and the rest of the system without rebuilding your core.</p><Link href="/login" className="mt-9 inline-flex items-center gap-2 bg-gradient-to-r from-[#205BFF] to-[#00A9E8] px-5 py-3 text-xs font-bold uppercase tracking-[0.14em] text-white">Start with Hesdor <ArrowRight size={15} /></Link></section>

      <footer className="border-t border-[#2A2E35] px-5 py-8 sm:px-8"><div className="mx-auto flex max-w-[1280px] flex-col items-start justify-between gap-5 sm:flex-row sm:items-center"><BrandLockup compact /><p className="text-[10px] uppercase tracking-[0.2em] text-[#59616C]">Unified access. Identities. Operations. One system.</p></div></footer>
    </main>
  );
}
