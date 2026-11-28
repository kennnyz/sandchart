import type { ComponentType, ReactNode } from "react";

/** The props the app passes to an icon: Lucide icons and the ones below both take them. */
export interface IconProps {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
}

export type Icon = ComponentType<IconProps>;

/** A chart-tool icon on Lucide's 24 px grid, stroked like Lucide so the rail reads as one set. */
function icon(name: string, body: ReactNode): Icon {
  function ChartIcon({ size = 24, strokeWidth = 2, className }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {body}
      </svg>
    );
  }
  ChartIcon.displayName = name;
  return ChartIcon;
}

/** A segment between two anchor points. */
export const TrendLineIcon = icon(
  "TrendLineIcon",
  <>
    <path d="M6.6 17.4 17.4 6.6" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="5" r="2" />
  </>,
);

/** A level across the chart with its anchor point. */
export const HorizontalLevelIcon = icon(
  "HorizontalLevelIcon",
  <>
    <path d="M3 12h7M14 12h7" />
    <circle cx="12" cy="12" r="2" />
  </>,
);

/** Retracement levels over the dashed move they are drawn on. */
export const FibonacciIcon = icon(
  "FibonacciIcon",
  <>
    <path d="M4 5h16M4 9.5h16M4 14h16M4 19h16" />
    <path d="M5 18.5 19 5.5" strokeDasharray="1.6 2.2" />
  </>,
);

/** A candle with a note marker above it. */
export const BarNoteIcon = icon(
  "BarNoteIcon",
  <>
    <rect x="10" y="12" width="4" height="7" rx="0.6" />
    <path d="M12 9.5V12M12 19v2.5" />
    <circle cx="12" cy="5" r="2.2" fill="currentColor" />
  </>,
);
