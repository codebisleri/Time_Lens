import {
  Compass,
  Database,
  LineChart,
  Layers,
  TrendingUp,
  ClipboardCheck,
  Gauge,
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
 * Single-workflow mode — the journey, in order:
 *   Data · EDA · Profile & Route · Forecast · Forecast Submission ·
 *   Performance · Scenarios · Report
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
        sections: [
          { label: "Overview", anchor: "overview" },
          { label: "Segmentation", anchor: "segmentation" },
          { label: "Routing", anchor: "routing" },
          { label: "Algorithm Portfolio", anchor: "algorithm-portfolio" },
          { label: "SKU Profiles", anchor: "sku-profiles" },
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
      {
        label: "Forecast Submission",
        href: routes.forecastSubmission,
        icon: ClipboardCheck,
      },
      { label: "Performance", href: routes.performance, icon: Gauge },
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
          { label: "Impact & Results", anchor: "results" },
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
