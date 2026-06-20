"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * F.19 §3/§6 — workflow "Continue to X" button with built-in loading + double-
 * click protection. On click it shows a spinner + the loading label, disables
 * itself, and navigates. The component unmounts on navigation, so the pending
 * state naturally clears at the destination.
 */
export function ContinueButton({
  href,
  label,
  loadingLabel = "Loading…",
  disabled = false,
  className,
}: {
  href: string;
  label: string;
  loadingLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      disabled={pending || disabled}
      aria-busy={pending}
      onClick={() => {
        if (pending) return; // ignore extra clicks
        setPending(true);
        router.push(href);
      }}
      className={cn("disabled:cursor-not-allowed disabled:opacity-70", className)}
    >
      {pending ? (
        <>
          <Loader2 className="size-4 animate-spin" /> {loadingLabel}
        </>
      ) : (
        <>
          {label} <ArrowRight className="size-4" />
        </>
      )}
    </Button>
  );
}
