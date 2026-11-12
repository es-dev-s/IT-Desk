export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid size-7 place-items-center rounded-lg bg-neutral-900 text-white shadow-xs">
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
          <rect x="2.5" y="3" width="4.5" height="4.5" rx="1.2" fill="currentColor" />
          <rect x="9" y="3" width="4.5" height="4.5" rx="1.2" fill="currentColor" opacity="0.45" />
          <rect x="2.5" y="9.5" width="4.5" height="4.5" rx="1.2" fill="currentColor" opacity="0.45" />
          <rect x="9" y="9.5" width="4.5" height="4.5" rx="1.2" fill="currentColor" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-neutral-900">IT-Desk</span>
    </span>
  );
}
