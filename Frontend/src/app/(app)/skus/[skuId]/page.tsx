import { PagePlaceholder } from "@/components/common/page-placeholder";

export default async function SkuDetailPage({
  params,
}: {
  params: Promise<{ skuId: string }>;
}) {
  const { skuId } = await params;
  return (
    <PagePlaceholder
      title="SKU Detail"
      description={`Detail view for ${skuId} — history, forecast, and metrics.`}
    />
  );
}
