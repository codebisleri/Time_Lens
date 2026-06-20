import { redirect } from "next/navigation";
import { DEFAULT_AUTHENTICATED_ROUTE } from "@/lib/constants/routes";

/** Root entry — middleware gates auth; authenticated users start the workflow
 *  at Data Upload (DEFAULT_AUTHENTICATED_ROUTE = /data). */
export default function RootPage() {
  redirect(DEFAULT_AUTHENTICATED_ROUTE);
}
