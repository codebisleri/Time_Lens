import type { Metadata } from "next";
import { ProfileRouteView } from "@/features/profile/profile-view";

export const metadata: Metadata = { title: "Profile & Route" };

export default function ProfilePage() {
  return <ProfileRouteView />;
}
