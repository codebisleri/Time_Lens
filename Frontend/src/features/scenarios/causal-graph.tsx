"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { GitBranch } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { EChartBase } from "@/components/charts/echart-base";
import { useAsync } from "@/lib/hooks";
import { useThemeMode } from "@/lib/theme/use-theme-mode";
import { readCssVar } from "@/lib/theme/theme-config";
import { chartColors } from "@/lib/charts/colors";
import { whatifService } from "@/lib/api/services";
import type { CausalGraphResponse, CausalNodeRole } from "@/types/whatif";

/**
 * Causal structure graph (Phase Y.6) — visual parity with the Streamlit
 * `build_causal_graph` DAG (st.graphviz_chart). It renders the EXACT structure
 * DoWhy is given (confounders → treatment & outcome; instruments → treatment;
 * effect modifiers → outcome; treatment → outcome) as an interactive ECharts
 * graph: directed arrows, role-coloured nodes, zoom / pan / fit (roam + toolbar).
 * READ-ONLY: it fetches `/scenarios/causal/graph`, which derives the nodes/edges
 * from the current selection without running DoWhy — no causal math changes.
 */

// Node role labels. Colours are resolved from the theme palette at render time
// (see `roleColors()` below) so the DAG tracks Light/Dark and stays on the brand
// navy + orange + grey system instead of hardcoded blue / green / purple.
const ROLE_META: Record<CausalNodeRole, { name: string }> = {
  treatment: { name: "Treatment" },
  outcome: { name: "Outcome" },
  confounder: { name: "Confounder" },
  instrument: { name: "Instrument" },
  effect_modifier: { name: "Effect modifier" },
};

/** Theme-bound role colours (distinct slots of the brand chart palette). */
function roleColors(): Record<CausalNodeRole, string> {
  const c = chartColors();
  return {
    treatment: c.accent, // orange — the lever under test
    outcome: c.primary, // navy — demand
    confounder: c.neutral, // grey
    instrument: c.palette[3]!, // light orange
    effect_modifier: c.palette[5]!, // muted navy
  };
}
const ROLE_ORDER: CausalNodeRole[] = [
  "treatment", "outcome", "confounder", "instrument", "effect_modifier",
];

function humanList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One-line, jargon-free summary of the assumed causal structure (Task 5). */
function explanationLine(g: CausalGraphResponse): string {
  const { treatments, outcome, confounders } = g.variables;
  if (!treatments.length || !outcome) return "";
  const verb = treatments.length > 1 ? "influence" : "influences";
  const adj = confounders.length ? ` after adjusting for ${humanList(confounders)}` : "";
  return `${humanList(treatments)} ${verb} ${outcome}${adj}.`;
}

export function CausalGraph({
  sku,
  treatments,
  confounders,
  instruments,
  effectModifiers,
}: {
  sku: string;
  treatments: string[];
  confounders: string[];
  instruments: string[];
  effectModifiers: string[];
}) {
  const { resolvedMode } = useThemeMode();
  // Stable dependency key so the read-only graph refetches whenever the selection
  // changes (arrays are recreated each render, so key on the serialized value).
  const key = JSON.stringify([sku, treatments, confounders, instruments, effectModifiers]);
  const graph = useAsync<CausalGraphResponse | null>(
    () =>
      treatments.length
        ? whatifService.causalGraph({ skuId: sku, treatments, confounders, instruments, effectModifiers })
        : Promise.resolve(null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const data = graph.data;
  const option = useMemo<EChartsOption>(() => {
    const nodes = data?.nodes ?? [];
    const edges = data?.edges ?? [];
    const present = ROLE_ORDER.filter((r) => nodes.some((n) => n.role === r));
    const roleIndex: Record<string, number> = Object.fromEntries(present.map((r, i) => [r, i]));
    const roleColor = roleColors();
    const labelColor = readCssVar("--foreground") || (resolvedMode === "dark" ? "#e2e8f0" : "#0f172a");
    const edgeColor = readCssVar("--muted-foreground") || (resolvedMode === "dark" ? "#64748b" : "#94a3b8");
    return {
      animationDuration: 400,
      tooltip: {
        formatter: (p: unknown) => {
          const d = p as {
            dataType?: string;
            data?: { name?: string; roleName?: string; source?: string; target?: string };
          };
          if (d?.dataType === "edge") return `${d.data?.source} → ${d.data?.target}`;
          return `${d?.data?.name ?? ""} · ${d?.data?.roleName ?? ""}`;
        },
      },
      legend: [
        {
          data: present.map((r) => ROLE_META[r].name),
          top: 0,
          textStyle: { color: labelColor },
          itemWidth: 12,
          itemHeight: 12,
        },
      ],
      color: present.map((r) => roleColor[r]),
      series: [
        {
          type: "graph",
          layout: "force",
          // Phase Y.16 · Tasks 1 & 2 — the graph is informational and FIXED: no
          // wheel/pinch/ctrl zoom (roam off) and no node/canvas dragging. Hover
          // tooltips + adjacency highlight (below) still work.
          roam: false,
          draggable: false,
          top: 40,
          symbolSize: 46,
          categories: present.map((r) => ({ name: ROLE_META[r].name })),
          label: {
            show: true,
            position: "right",
            fontSize: 11,
            color: labelColor,
            overflow: "truncate",
            width: 120,
          },
          edgeSymbol: ["none", "arrow"], // directed arrow heads
          edgeSymbolSize: [0, 9],
          force: { repulsion: 320, edgeLength: 130, gravity: 0.08 },
          lineStyle: {
            color: edgeColor,
            width: 1.5,
            opacity: 0.85,
          },
          emphasis: { focus: "adjacency", lineStyle: { width: 3 } },
          data: nodes.map((n) => ({
            name: n.label,
            roleName: ROLE_META[n.role].name,
            category: roleIndex[n.role],
            itemStyle: { color: roleColor[n.role] },
          })),
          links: edges.map((e) => ({ source: e.source, target: e.target })),
        },
      ],
    };
  }, [data, resolvedMode]);

  // Empty state (Task 6) — nothing selected yet.
  if (!treatments.length) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            icon={GitBranch}
            title="Causal structure"
            description="Select treatment and adjustment variables to visualize the causal structure."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <GitBranch className="size-4 text-primary" /> Causal structure — how the levers connect
        </p>
        {graph.isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : graph.isError || !data || data.nodes.length === 0 ? (
          // Error / unbuildable configuration (Task 7) — never crashes.
          <EmptyState
            title="Causal graph unavailable for the selected configuration."
            description="Try a different treatment or adjustment selection."
          />
        ) : (
          <>
            <EChartBase option={option} height={360} />
            {explanationLine(data) ? (
              <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground">
                {explanationLine(data)}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
