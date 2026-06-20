import { PagePlaceholder } from "@/components/common/page-placeholder";

export default async function ScenarioDetailPage({
  params,
}: {
  params: Promise<{ scenarioId: string }>;
}) {
  const { scenarioId } = await params;
  return (
    <PagePlaceholder
      title="Scenario Detail"
      description={`Scenario ${scenarioId} — levers, projected demand, and summary.`}
    />
  );
}
