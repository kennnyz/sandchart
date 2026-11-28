import { ChevronsDown, ChevronsUp, CircleX, FastForward, FolderOpen, LogOut, Pause, Play, Save, StepForward, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { t } from "../i18n";
import { MAX_REPLAY_FILE_MIB, replayKeyAction, SPEEDS, type ReplayController } from "../state/replay";

export interface ReplayBarProps {
  replay: ReplayController;
  /** Open time of the first and last loaded bar, the range a start date can be picked from. */
  range: [number, number] | null;
  /** A start date was picked (UTC midnight of the day). */
  onDate: (time: number) => void;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "→", "Space", "⇧B". */
const KEYS = { step: "→", play: "Space", buy: "⇧B", sell: "⇧S", close: "⇧C" } as const;
const titled = (name: string, shortcut: string) => t("replay.shortcut", { name, shortcut });

/**
 * A click does not move focus to a button (as in WebKit), so Space after a click on a control
 * plays or pauses instead of pressing that button again. Tab still focuses them.
 */
const keepFocus = (e: MouseEvent<HTMLDivElement>) => {
  if ((e.target as HTMLElement).closest("button")) e.preventDefault();
};

/**
 * The replay controls under the chart: while a start is picked, the hint, a date and Open;
 * while replaying, Step, Play, speed, Buy, Sell, Close trade, Save, Open and Exit. It also
 * owns the replay keys and stops Play when the window is hidden.
 */
export function ReplayBar({ replay: r, range, onDate }: ReplayBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = replayKeyAction(e, r.phase);
      if (!action) return;
      e.preventDefault();
      if (action === "step") void r.step(e.repeat);
      else if (action === "play") r.togglePlay();
      else if (action === "buy") void r.buy();
      else if (action === "sell") void r.sell();
      else if (action === "close") void r.closeTrade();
      else r.cancelPick();
    };
    const onVisible = () => r.visibility(document.visibilityState === "hidden");
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [r]);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so that picking the same file again fires `change` again.
    e.target.value = "";
    setFileError(null);
    if (!file) return;
    if (file.size > MAX_REPLAY_FILE_MIB * 1024 * 1024) {
      setFileError(t("replay.tooLarge", { mib: MAX_REPLAY_FILE_MIB }));
      return;
    }
    void file.arrayBuffer().then((b) => r.open(new Uint8Array(b)));
  };

  const openButton = (
    <>
      <button
        className="text-button with-icon"
        data-testid="replay-open"
        title={t("replay.openTitle")}
        onClick={() => fileRef.current?.click()}
      >
        <FolderOpen size={14} />
        {t("replay.open")}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".replay"
        hidden
        data-testid="replay-file"
        aria-label={t("replay.openTitle")}
        onChange={onFile}
      />
    </>
  );
  const error = fileError;

  if (r.phase === "picking") {
    return (
      <div className="replay-bar" role="toolbar" aria-label={t("replay.controls")} data-testid="replay-bar" onMouseDown={keepFocus}>
        <FastForward size={14} className="replay-icon" />
        <span className="replay-hint" data-testid="replay-hint">
          {t("replay.hint")}
        </span>
        <input
          type="date"
          className="replay-date mono"
          data-testid="replay-date"
          aria-label={t("replay.date")}
          min={range ? day(range[0]) : undefined}
          max={range ? day(range[1]) : undefined}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (Number.isFinite(v)) onDate(v);
          }}
        />
        <div className="spacer" />
        {error && <span className="replay-file-error">{error}</span>}
        {openButton}
        <button className="text-button with-icon" data-testid="replay-cancel" onClick={() => r.cancelPick()}>
          <X size={14} />
          {t("replay.cancel")}
        </button>
      </div>
    );
  }

  const v = r.view;
  const atEnd = v?.atEnd ?? true;
  const hasOpen = v?.open != null;
  return (
    <div className="replay-bar" role="toolbar" aria-label={t("replay.controls")} data-testid="replay-bar" onMouseDown={keepFocus}>
      <button
        className="icon-button"
        data-testid="replay-step"
        aria-label={t("replay.step")}
        title={titled(t("replay.step"), KEYS.step)}
        disabled={atEnd}
        onClick={() => void r.step()}
      >
        <StepForward size={16} />
      </button>
      <button
        className="icon-button"
        data-testid="replay-play"
        aria-label={r.playing ? t("replay.pause") : t("replay.play")}
        aria-pressed={r.playing}
        title={titled(r.playing ? t("replay.pause") : t("replay.play"), KEYS.play)}
        disabled={atEnd && !r.playing}
        onClick={() => r.togglePlay()}
      >
        {r.playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="replay-speeds" role="group" aria-label={t("replay.speed")}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            className="replay-speed mono"
            data-testid={`replay-speed-${s}`}
            aria-pressed={r.speed === s}
            title={t("replay.speedValue", { n: s })}
            onClick={() => r.setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
      {atEnd && <span className="replay-end">{t("replay.end")}</span>}
      <div className="divider" />
      <button
        className="text-button with-icon"
        data-testid="replay-buy"
        title={titled(t("replay.buy"), KEYS.buy)}
        disabled={hasOpen}
        onClick={() => void r.buy()}
      >
        <ChevronsUp size={14} />
        {t("replay.buy")}
      </button>
      <button
        className="text-button with-icon"
        data-testid="replay-sell"
        title={titled(t("replay.sell"), KEYS.sell)}
        disabled={hasOpen}
        onClick={() => void r.sell()}
      >
        <ChevronsDown size={14} />
        {t("replay.sell")}
      </button>
      <button
        className="text-button with-icon"
        data-testid="replay-close"
        title={titled(t("replay.closeTrade"), KEYS.close)}
        disabled={!hasOpen}
        onClick={() => void r.closeTrade()}
      >
        <CircleX size={14} />
        {t("replay.closeTrade")}
      </button>
      <div className="spacer" />
      {error && <span className="replay-file-error">{error}</span>}
      <button className="text-button with-icon" data-testid="replay-save" onClick={() => void r.save()}>
        <Save size={14} />
        {t("replay.save")}
      </button>
      {openButton}
      <button className="text-button with-icon" data-testid="replay-exit" onClick={() => void r.exit()}>
        <LogOut size={14} />
        {t("replay.exit")}
      </button>
    </div>
  );
}
