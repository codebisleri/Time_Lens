import { PagePlaceholder } from "@/components/common/page-placeholder";

export default async function ForecastDetailPage({
  params,
}: {
  params: Promise<{ forecastId: string }>;
}) {
  const { forecastId } = await params;
  return (
    <PagePlaceholder
      title="Forecast Detail"
      description={`Forecast ${forecastId} — series, confidence bands, and metrics.`}
    />
  );
}
