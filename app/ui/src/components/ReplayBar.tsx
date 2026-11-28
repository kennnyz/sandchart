import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  CircleX,
  FastForward,
  FolderOpen,
  MousePointerClick,
  Pause,
  Play,
  Rewind,
  Save,
  StepForward,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { TIMEFRAME_CODES } from "../backend/types";
import { formatCrosshairTime } from "../chart/format";
import { t } from "../i18n";
import { baseChoices, MAX_REPLAY_FILE_MIB, replayKeyAction, SPEEDS, type ReplayController } from "../state/replay";
import { Menu, type MenuItem } from "./Menu";
import { tfLabel } from "./TimeframePicker";

export interface ReplayBarProps {
  replay: ReplayController;
  /** Open time of the first and last loaded bar, the range a start date can be picked from. */
  range: [number, number] | null;
  /** A start date was picked (UTC midnight of the day). */
  onDate: (time: number) => void;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "→", "Space", "⇧B". */
/** The replay keys as shown in tooltips and menus. */
export const REPLAY_KEYS = { step: "→", play: "Space", buy: "⇧B", sell: "⇧S", close: "⇧C" } as const;
const KEYS = REPLAY_KEYS;
const titled = (name: string, shortcut: string) => t("replay.shortcut", { name, shortcut });

/**
 * A click does not move focus to a button (as in WebKit), so Space after a click on a control
 * plays or pauses instead of pressing that button again. Tab still focuses them.
 */
const keepFocus = (e: MouseEvent<HTMLDivElement>) => {
  if ((e.target as HTMLElement).closest("button")) e.preventDefault();
};

type MenuId = "select" | "speed" | "interval";

/**
 * The replay controls, centred under the chart. While a start is picked: the hint, a date,
 * Open and Cancel. While replaying: Select bar, Play, Step, speed, update interval, jump to
 * real time, Buy, Sell, Close trade, Save, Open and Exit. It also owns the replay keys and
 * stops Play when the window is hidden.
 */
export function ReplayBar({ replay: r, range, onDate }: ReplayBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  /** The open dropdown, under the button it belongs to (window px). */
  const [menu, setMenu] = useState<{ id: MenuId; x: number; y: number } | null>(null);
  /** "Pick a date" was chosen: the date field takes focus once picking starts. */
  const [wantDate, setWantDate] = useState(false);

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

  // Esc answers the question with "no".
  const confirming = r.confirming;
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setWantDate(false);
      r.cancelSelectBar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, r]);

  // Esc closes a dropdown wherever focus is (WebKit does not focus a clicked button).
  const menuOpen = menu !== null;
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const picking = r.phase === "picking";
  useEffect(() => {
    if (!picking || !wantDate) return;
    setWantDate(false);
    const el = dateRef.current;
    el?.focus();
    try {
      el?.showPicker();
    } catch {
      // Not every engine opens the picker from script; the field has focus.
    }
  }, [picking, wantDate]);

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

  /** The menu was open when the press on its own button began (that press closed it). */
  const wasOpen = useRef<MenuId | null>(null);
  const menuButton = (id: MenuId) => ({
    "aria-haspopup": "menu" as const,
    "aria-expanded": menu?.id === id,
    onPointerDown: () => {
      wasOpen.current = menu?.id === id ? id : null;
    },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      const closing = wasOpen.current === id || menu?.id === id;
      wasOpen.current = null;
      if (closing) {
        setMenu(null);
        return;
      }
      const box = e.currentTarget.getBoundingClientRect();
      setMenu({ id, x: box.left, y: box.top });
    },
  });
  const closeMenu = () => setMenu(null);

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
  const error = fileError && <span className="replay-file-error">{fileError}</span>;

  if (picking) {
    return (
      <div className="replay-bar" role="toolbar" aria-label={t("replay.controls")} data-testid="replay-bar" onMouseDown={keepFocus}>
        <div className="replay-controls">
          <Rewind size={14} className="replay-icon" />
          <span className="replay-hint" data-testid="replay-hint">
            {t("replay.hint")}
          </span>
          <input
            ref={dateRef}
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
          <div className="divider" />
          {openButton}
          {error}
        </div>
        <button
          className="icon-button replay-exit"
          data-testid="replay-cancel"
          aria-label={t("replay.cancel")}
          title={t("replay.cancel")}
          onClick={() => r.cancelPick()}
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  const v = r.view;
  const finished = r.finished;
  const atEnd = v?.atEnd ?? true;
  const hasOpen = v?.open != null;
  // Steps and commands are refused once the backtest ended at real time; the tooltip says why.
  const stepTitle = (name: string, key: string) =>
    finished ? t("replay.realTime.title") : atEnd ? t("replay.endTitle") : titled(name, key);
  const tradeTitle = (name: string, key: string) => (finished ? t("replay.realTime.title") : titled(name, key));

  const pickBar = (date: boolean) => {
    closeMenu();
    setWantDate(date);
    void r.selectBar();
  };
  let items: MenuItem[] = [];
  let menuLabel = "";
  if (menu?.id === "select") {
    menuLabel = t("replay.selectBar");
    items = [
      { id: "chart", label: t("replay.selectBar.onChart"), icon: MousePointerClick, onSelect: () => pickBar(false) },
      { id: "date", label: t("replay.selectBar.date"), icon: CalendarDays, onSelect: () => pickBar(true) },
    ];
  } else if (menu?.id === "speed") {
    menuLabel = t("replay.speed");
    items = SPEEDS.map((s) => ({
      id: String(s),
      label: `${s}x`,
      icon: r.speed === s ? Check : undefined,
      checked: r.speed === s,
      title: t("replay.speedValue", { n: s }),
      onSelect: () => {
        closeMenu();
        r.setSpeed(s);
      },
    }));
  } else if (menu?.id === "interval" && v) {
    menuLabel = t("replay.interval");
    items = baseChoices(v.tf, v.base, v.cut, TIMEFRAME_CODES).map(({ tf, stepTo }) => ({
      id: tf,
      label: tfLabel(tf),
      icon: v.base === tf ? Check : undefined,
      checked: v.base === tf,
      disabled: stepTo !== null,
      title: stepTo !== null ? t("replay.interval.stepTo", { time: formatCrosshairTime(stepTo, "1m") }) : undefined,
      onSelect: () => {
        closeMenu();
        void r.setBase(tf);
      },
    }));
  }
  const intervalLabel = t("replay.interval.value", { tf: v ? tfLabel(v.base) : "" });

  return (
    <div
      className="replay-bar"
      role="toolbar"
      aria-label={t("replay.controls")}
      data-testid="replay-bar"
      data-cut={v?.cut ?? ""}
      data-finished={finished}
      onMouseDown={keepFocus}
    >
      <div className="replay-controls">
        <div className="replay-anchor">
          <button
            className="text-button with-icon"
            data-testid="replay-select"
            {...menuButton("select")}
            title={t("replay.selectBar.title")}
                      >
            <Rewind size={14} />
            {t("replay.selectBar")}
            <ChevronDown size={12} />
          </button>
          {confirming && (
            <div
              className="replay-confirm"
              role="alertdialog"
              aria-labelledby="replay-confirm-title"
              aria-describedby="replay-confirm-text"
              data-testid="replay-confirm"
            >
              <div id="replay-confirm-title" className="replay-confirm-title">
                {t("replay.confirm.title")}
              </div>
              <div id="replay-confirm-text" className="replay-confirm-text">
                {t("replay.confirm.text")}
              </div>
              <div className="replay-confirm-actions">
                <button
                  className="text-button"
                  data-testid="replay-confirm-cancel"
                  onClick={() => {
                    setWantDate(false);
                    r.cancelSelectBar();
                  }}
                >
                  {t("replay.cancel")}
                </button>
                <button
                  className="text-button bordered"
                  data-testid="replay-confirm-ok"
                  autoFocus
                  onClick={() => void r.confirmSelectBar()}
                >
                  {t("replay.confirm.ok")}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="divider" />
        <button
          className="icon-button"
          data-testid="replay-play"
          aria-label={r.playing ? t("replay.pause") : t("replay.play")}
          aria-pressed={r.playing}
          title={r.playing ? titled(t("replay.pause"), KEYS.play) : stepTitle(t("replay.play"), KEYS.play)}
          disabled={(atEnd || finished) && !r.playing}
          onClick={() => r.togglePlay()}
        >
          {r.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          className="icon-button"
          data-testid="replay-step"
          aria-label={t("replay.step")}
          title={stepTitle(t("replay.step"), KEYS.step)}
          disabled={atEnd || finished}
          onClick={() => void r.step()}
        >
          <StepForward size={16} />
        </button>
        <button
          className="text-button with-icon mono"
          data-testid="replay-speed"
          {...menuButton("speed")}
          aria-label={`${t("replay.speed")}: ${r.speed}x`}
          title={t("replay.speedValue", { n: r.speed })}
                  >
          {r.speed}x
          <ChevronDown size={12} />
        </button>
        <button
          className="text-button with-icon mono"
          data-testid="replay-interval"
          {...menuButton("interval")}
          aria-label={intervalLabel}
          title={intervalLabel}
          disabled={!v}
                  >
          {v ? tfLabel(v.base) : ""}
          <ChevronDown size={12} />
        </button>
        <button
          className="icon-button"
          data-testid="replay-jump"
          aria-label={t("replay.jump")}
          title={finished ? t("replay.realTime.title") : atEnd ? t("replay.endTitle") : t("replay.jump")}
          disabled={atEnd || finished}
          onClick={() => void r.jumpToEnd()}
        >
          <FastForward size={16} />
        </button>
        <div className="divider" />
        <button
          className="text-button with-icon"
          data-testid="replay-buy"
          title={tradeTitle(t("replay.buy"), KEYS.buy)}
          disabled={hasOpen || finished}
          onClick={() => void r.buy()}
        >
          <ChevronsUp size={14} />
          {t("replay.buy")}
        </button>
        <button
          className="text-button with-icon"
          data-testid="replay-sell"
          title={tradeTitle(t("replay.sell"), KEYS.sell)}
          disabled={hasOpen || finished}
          onClick={() => void r.sell()}
        >
          <ChevronsDown size={14} />
          {t("replay.sell")}
        </button>
        <button
          className="text-button with-icon"
          data-testid="replay-close"
          title={tradeTitle(t("replay.closeTrade"), KEYS.close)}
          disabled={!hasOpen || finished}
          onClick={() => void r.closeTrade()}
        >
          <CircleX size={14} />
          {t("replay.closeTrade")}
        </button>
        <div className="divider" />
        <button className="text-button with-icon" data-testid="replay-save" onClick={() => void r.save()}>
          <Save size={14} />
          {t("replay.save")}
        </button>
        {openButton}
        {finished ? (
          <span className="replay-end" data-testid="replay-real-time" title={t("replay.realTime.title")}>
            {t("replay.realTime")}
          </span>
        ) : (
          atEnd && <span className="replay-end">{t("replay.end")}</span>
        )}
        {error}
      </div>
      <button
        className="icon-button replay-exit"
        data-testid="replay-exit"
        aria-label={t("replay.exit")}
        title={t("replay.exit")}
        onClick={() => void r.exit()}
      >
        <X size={16} />
      </button>
      {menu && items.length > 0 && (
        <Menu
          key={menu.id}
          items={items}
          label={menuLabel}
          testId={`replay-${menu.id}-menu`}
          x={menu.x}
          y={menu.y}
          width={window.innerWidth}
          // Only the room above the button: the menu always opens upwards, over the chart.
          height={menu.y}
          fixed
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
