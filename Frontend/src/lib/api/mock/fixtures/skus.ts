import type { Sku } from "@/types/sku";

const categories = ["Beverages", "Snacks", "Dairy", "Bakery", "Frozen"];
const regions = ["North", "South", "East", "West"];

export const mockSkus: Sku[] = Array.from({ length: 48 }, (_, i) => {
  const n = i + 1;
  const category = categories[i % categories.length]!;
  const region = regions[i % regions.length]!;
  return {
    id: `sku_${String(n).padStart(3, "0")}`,
    code: `SKU-${1000 + n}`,
    name: `${category} Item ${n}`,
    category,
    region,
    brand: `Brand ${(i % 6) + 1}`,
    status: i % 9 === 0 ? "new" : i % 13 === 0 ? "inactive" : "active",
    unitCost: 2 + (i % 7),
    unitPrice: 5 + (i % 11),
    leadTimeDays: 3 + (i % 10),
    forecastAccuracy: 0.78 + ((i % 18) / 100),
    hasForecast: i % 4 !== 0,
    updatedAt: "2026-06-10T12:00:00.000Z",
  } satisfies Sku;
});
