import type { Metadata } from "next";
import { EdaView } from "@/features/eda/eda-view";

export const metadata: Metadata = { title: "Exploratory Data Analysis" };

export default function EdaPage() {
  return <EdaView />;
}
