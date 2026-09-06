export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#6366F1] to-[#8b5cf6] text-white ${className ?? ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-4"
        aria-hidden="true"
      >
        <path
          d="M5 6.5A2.5 2.5 0 0 1 7.5 4h3a1.5 1.5 0 0 1 1 .4V18a1.5 1.5 0 0 0-1-.4h-3A2.5 2.5 0 0 0 5 20V6.5ZM19 6.5A2.5 2.5 0 0 0 16.5 4h-3a1.5 1.5 0 0 0-1 .4V18a1.5 1.5 0 0 1 1-.4h3A2.5 2.5 0 0 1 19 20V6.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
        />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      </svg>
    </span>
  );
}

export function BrandLogo({ text = true }: { text?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark />
      {text && (
        <span className="text-[15px] font-semibold tracking-tight text-foreground">
          启创<span className="mx-px text-muted-foreground">·</span>
          InnoSpark
        </span>
      )}
    </span>
  );
}
