import { TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

export interface BannerProps {
  text: string;
  /** When the next attempt runs (ms since epoch); no countdown when null. */
  retryAt: number | null;
  retryLabel: (seconds: number) => string;
  /** The raw provider error, shown as a tooltip. */
  detail?: string;
  testId?: string;
  /** Shows a close button that calls this, with this label. */
  dismiss?: { label: string; onDismiss: () => void };
}

/** The warning strip at the top of the chart (Design Reference, States). */
export function Banner({ text, retryAt, retryLabel, detail, testId = "banner", dismiss }: BannerProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (retryAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const seconds = retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <div className="banner" data-testid={testId} role="status" title={detail}>
      <TriangleAlert size={14} />
      <span className="text">{text}</span>
      {seconds !== null && <span className="retry mono">{retryLabel(seconds)}</span>}
      {dismiss && (
        <button type="button" className="icon-button" aria-label={dismiss.label} title={dismiss.label} onClick={dismiss.onDismiss}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
