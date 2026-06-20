"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { loginSchema, type LoginFormValues } from "@/lib/validation";
import { useAuthStore } from "@/lib/stores";
import { DEFAULT_AUTHENTICATED_ROUTE } from "@/lib/constants/routes";
import { resetCachedSessionState } from "@/lib/utils/session";
import { cn } from "@/lib/utils";

type SubmitState = "idle" | "submitting" | "success" | "error";

/**
 * Enterprise login card. React Hook Form + Zod validation, authenticating
 * through the existing auth store / auth service. Surfaces loading, error, and
 * success states. On success, redirects to the originally-requested route
 * (?from=) or the workflow entry point (Data Upload).
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = useAuthStore((s) => s.login);

  const [state, setState] = useState<SubmitState>("idle");
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", rememberMe: false },
  });

  async function onSubmit(values: LoginFormValues) {
    setState("submitting");
    setServerError(null);

    const ok = await login(values);

    if (!ok) {
      setState("error");
      setServerError(
        useAuthStore.getState().error ?? "Unable to sign in. Please try again.",
      );
      return;
    }

    setState("success");
    // §1 — start every session clean: drop cached EDA results, selections,
    // filters, and any stale in-flight forecast-job handle before entering.
    resetCachedSessionState();
    const redirectTo = searchParams.get("from") || DEFAULT_AUTHENTICATED_ROUTE;
    // Brief success affordance before navigating.
    router.replace(redirectTo);
  }

  const busy = state === "submitting" || state === "success";

  return (
    <div className="w-full">
        {serverError ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive animate-fade-in"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{serverError}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {/* Email */}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                className="pl-9"
                aria-invalid={!!errors.email}
                disabled={busy}
                {...register("email")}
              />
            </div>
            {errors.email ? (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            ) : null}
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="#"
                className="text-xs font-medium text-primary transition-colors hover:text-primary/80"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                className="pl-9 pr-10"
                aria-invalid={!!errors.password}
                disabled={busy}
                {...register("password")}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                disabled={busy}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {errors.password ? (
              <p className="text-xs text-destructive">
                {errors.password.message}
              </p>
            ) : null}
          </div>

          {/* Remember me */}
          <div className="flex items-center gap-2">
            <Controller
              control={control}
              name="rememberMe"
              render={({ field }) => (
                <Checkbox
                  id="rememberMe"
                  checked={field.value}
                  onCheckedChange={(v) => field.onChange(v === true)}
                  disabled={busy}
                />
              )}
            />
            <Label
              htmlFor="rememberMe"
              className="cursor-pointer text-sm font-normal text-muted-foreground"
            >
              Remember me for 30 days
            </Label>
          </div>

          {/* Submit */}
          <Button
            type="submit"
            className={cn(
              // §F.15 — large primary CTA with an orange gradient + hover lift/glow.
              "h-11 w-full border-0 text-base font-semibold transition-all duration-200",
              state === "success"
                ? "bg-success text-success-foreground hover:bg-success"
                : "bg-gradient-to-r from-[#EF7602] to-[#FF9B3D] text-white shadow-[0_10px_30px_-8px_rgba(239,118,2,0.6)] hover:-translate-y-0.5 hover:brightness-105 hover:shadow-[0_14px_36px_-8px_rgba(239,118,2,0.75)]",
            )}
            disabled={busy}
          >
            {state === "submitting" ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Signing in…
              </>
            ) : state === "success" ? (
              <>
                <Check className="size-4" />
                Signed in
              </>
            ) : (
              <>
                Sign in
                <ArrowRight className="size-4" />
              </>
            )}
          </Button>
        </form>
    </div>
  );
}
