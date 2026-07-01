import {
  Compass,
  Database,
  LineChart,
  Layers,
  TrendingUp,
  ClipboardCheck,
  Gauge,
  PieChart,
  SlidersHorizontal,
  FileBarChart,
  type LucideIcon,
} from "lucide-react";
import { routes } from "./routes";

/**
 * Single source of truth for primary navigation. The sidebar renders entirely
 * from this config and breadcrumbs derive labels from it — adding a page means
 * adding one entry here, nothing else.
 *
 * Single-workflow mode — the journey, in order (Phase Y.3 · Task 4 — Performance
 * now precedes Forecast Submission):
 *   Data · EDA · Profile & Route · Forecast · Performance ·
 *   Forecast Submission · Scenarios · Report
 * (Dashboard is intentionally excluded; Scenarios is the post-forecast what-if.)
 */
/** In-page section the sidebar can jump to via an #anchor on the route. */
export interface NavSubSection {
  label: string;
  anchor: string;
}

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Extra path prefixes that should mark this item active (nested routes). */
  matchPrefixes?: string[];
  badge?: string;
  /** Sub-navigation: in-page sections shown under the active item (F.9 Part 9). */
  sections?: NavSubSection[];
}

export interface NavSection {
  /** Section heading; omit for an ungrouped top item. */
  title?: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    items: [{ label: "Overview", href: routes.overview, icon: Compass }],
  },
  {
    title: "Data",
    items: [
      // href "/data" also matches the nested "/data/*" config sub-routes.
      {
        label: "Input Data & Configuration",
        href: routes.data,
        icon: Database,
        sections: [
          { label: "Upload", anchor: "upload" },
          { label: "Input Configuration", anchor: "input-configuration" },
          { label: "Event Calendar", anchor: "event-calendar" },
          { label: "Data Quality Check", anchor: "data-quality" },
        ],
      },
    ],
  },
  {
    title: "Analysis",
    items: [
      {
        label: "EDA",
        href: routes.eda,
        icon: LineChart,
        sections: [
          { label: "Summary", anchor: "summary" },
          { label: "Distribution Analysis", anchor: "distribution" },
          { label: "Time Series Analysis", anchor: "time-series" },
          { label: "Seasonal Decomposition", anchor: "seasonal-decomposition" },
          { label: "Anomaly Detection", anchor: "anomaly" },
          { label: "Correlation Analysis", anchor: "correlation" },
          { label: "Holiday Analysis", anchor: "holiday" },
        ],
      },
      {
        label: "Profile & Route",
        href: routes.profile,
        icon: Layers,
        // Phase X.O — the Routing / Algorithm-Portfolio display sections were
        // removed; their nav entries go with them (the routing engine is
        // unchanged). Remaining in-page anchors only.
        sections: [
          { label: "Overview", anchor: "overview" },
          { label: "Segmentation", anchor: "segmentation" },
          { label: "Profiles", anchor: "sku-profiles" },
        ],
      },
    ],
  },
  {
    title: "Forecasting",
    items: [
      {
        label: "Forecast",
        href: routes.forecast,
        icon: TrendingUp,
        sections: [
          { label: "Configuration", anchor: "configuration" },
          { label: "Execution", anchor: "execution" },
          { label: "Results", anchor: "results" },
        ],
      },
      { label: "Performance", href: routes.performance, icon: Gauge },
      {
        label: "Forecast Submission",
        href: routes.forecastSubmission,
        icon: ClipboardCheck,
      },
      // Phase X.U — read-only explainability step: Forecast → Explainability → Scenario.
      {
        label: "Explainability",
        href: routes.explainability,
        icon: PieChart,
        sections: [
          { label: "Summary", anchor: "summary" },
          // Phase Y.12 — distinct Global vs Local driver-contribution sections.
          { label: "Global Driver Contributions", anchor: "drivers" },
          { label: "Local Driver Contributions", anchor: "local" },
          { label: "By Horizon", anchor: "horizon" },
        ],
      },
    ],
  },
  {
    title: "Planning",
    items: [
      {
        label: "Scenarios",
        href: routes.scenarios,
        icon: SlidersHorizontal,
        sections: [
          { label: "Build Scenario", anchor: "build" },
          // Task 6 — surface the causal "What We Found" results (DoWhy) in the
          // sub-nav; the anchor targets the results block in both scenario modes.
          { label: "What We Found", anchor: "results" },
        ],
      },
      {
        label: "Report",
        href: routes.report,
        icon: FileBarChart,
        sections: [
          { label: "Summary", anchor: "summary" },
          { label: "Generate Reports", anchor: "generate" },
        ],
      },
    ],
  },
];
