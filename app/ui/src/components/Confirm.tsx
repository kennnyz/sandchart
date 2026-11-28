import { useEffect } from "react";

export interface ConfirmProps {
  title: string;
  text: string;
  ok: string;
  cancel: string;
  testId: string;
  onAnswer: (yes: boolean) => void;
}

/**
 * A small in-page question over the top of the chart: the button that goes on takes focus,
 * Esc and Cancel say no. Rendered inside the chart host (position: relative).
 */
export function Confirm({ title, text, ok, cancel, testId, onAnswer }: ConfirmProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onAnswer(false);
    };
    // Capture: Esc answers here before it reaches the chart's own keys.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onAnswer]);
  return (
    <div className="chart-confirm" role="alertdialog" aria-labelledby={`${testId}-title`} aria-describedby={`${testId}-text`} data-testid={testId}>
      <div id={`${testId}-title`} className="replay-confirm-title">
        {title}
      </div>
      <div id={`${testId}-text`} className="replay-confirm-text">
        {text}
      </div>
      <div className="replay-confirm-actions">
        <button className="text-button" data-testid={`${testId}-cancel`} onClick={() => onAnswer(false)}>
          {cancel}
        </button>
        <button className="text-button bordered" data-testid={`${testId}-ok`} autoFocus onClick={() => onAnswer(true)}>
          {ok}
        </button>
      </div>
    </div>
  );
}
