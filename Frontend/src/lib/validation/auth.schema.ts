import { z } from "zod";

/** Login form schema — consumed by React Hook Form via zodResolver. */
export const loginSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
  rememberMe: z.boolean().optional().default(false),
});

export type LoginFormValues = z.infer<typeof loginSchema>;
