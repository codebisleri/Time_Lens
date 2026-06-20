import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Brand assets. Logos live in /public (PNG, transparent). Sizes are controlled
 * via `h-* w-auto` so aspect ratios are always preserved (intrinsic dimensions
 * are passed to next/image for crispness/optimization).
 */

/** Time Lens product logomark (865×772, ~square). */
export function TimeLensLogo({ className }: { className?: string }) {
  return (
    <Image
      src="/time-lens-logo.png"
      alt="Time Lens"
      width={865}
      height={772}
      priority
      unoptimized
      className={cn("h-7 w-auto select-none", className)}
    />
  );
}

/**
 * DhishaAI parent-company wordmark (9400×3000, ~3.1:1).
 *
 * The wordmark uses deep navy glyphs, which lose contrast on dark surfaces
 * (dark theme background, the navy sidebar). Pass `plate` to render it on a
 * light "brand plate" so it stays crisp on ANY background — the recommended
 * treatment anywhere the wordmark sits on a dark or unknown surface.
 */
export function DhishaaiWordmark({
  className,
  plate = false,
}: {
  className?: string;
  plate?: boolean;
}) {
  const img = (
    <Image
      src="/dhishaai-logo.png"
      alt="DhishaAI"
      width={9400}
      height={3000}
      unoptimized
      className={cn("h-6 w-auto select-none", className)}
    />
  );
  if (!plate) return img;
  return (
    <span className="inline-flex items-center rounded-md bg-white px-2.5 py-1 shadow-sm ring-1 ring-black/5">
      {img}
    </span>
  );
}
