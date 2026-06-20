import { cn } from "@/lib/utils";

/**
 * Lightweight inline-SVG sparkline for KPI tiles. No ECharts instance (keeps
 * KPI cards cheap and SSR-friendly); color is theme-token driven via
 * currentColor, so callers tint with text-* classes.
 */
interface SparklineProps {
  data: number[];
  /** Unique id seed for the gradient fill (must differ per sparkline). */
  id: string;
  className?: string;
  width?: number;
  height?: number;
  /** Render the soft area fill below the line. */
  filled?: boolean;
}

export function Sparkline({
  data,
  id,
  className,
  width = 120,
  height = 36,
  filled = true,
}: SparklineProps) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pad = 2;

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = pad + (height - pad * 2) * (1 - (v - min) / range);
    return [x, y] as const;
  });

  const line = points.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `${line} ${width},${height} 0,${height}`;
  const gradientId = `spark-${id}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-9 w-full overflow-visible", className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      {filled ? <polygon points={area} fill={`url(#${gradientId})`} /> : null}
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
