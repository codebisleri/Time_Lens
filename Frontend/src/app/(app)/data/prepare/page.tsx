import { redirect } from "next/navigation";
import { routes } from "@/lib/constants/routes";

// Upload and Prepare are now consolidated into a single Data page. This legacy
// route redirects so old links keep working.
export default function DataPreparePage() {
  redirect(routes.data);
}
