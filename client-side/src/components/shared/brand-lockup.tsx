type BrandLockupProps = {
  compact?: boolean;
};

export function BrandMark({ size = 38 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 64 64" fill="none">
      <defs>
        <linearGradient id="hesdor-cobalt-cyan" x1="8" y1="5" x2="33" y2="57" gradientUnits="userSpaceOnUse">
          <stop stopColor="#205BFF" />
          <stop offset="1" stopColor="#00D4FF" />
        </linearGradient>
      </defs>
      <path fill="url(#hesdor-cobalt-cyan)" d="M8 13 32 0v16l-11 6v14l11-6v16L8 60V13Z" />
      <path fill="currentColor" className="text-text-faint" d="M56 13 33 0v16l11 6v14l-11-6v16l23 14V13Z" />
      <path fill="currentColor" className="text-border-strong" d="m21 22 11-6v14l-11 6V22Zm11 8 11 6v14l-11-6V30Z" />
    </svg>
  );
}

export function BrandLockup({ compact = false }: BrandLockupProps) {
  return (
    <div className="flex items-center gap-3" aria-label="Hesdor Workplace Infrastructure">
      <BrandMark size={compact ? 30 : 42} />
      <div>
        <div className="font-headline text-[17px] font-extrabold leading-none tracking-[0.22em] text-text">HESDOR</div>
        {!compact ? <div className="mt-1.5 text-[8px] font-semibold uppercase tracking-[0.3em] text-text-faint">Workplace Infrastructure</div> : null}
      </div>
    </div>
  );
}
