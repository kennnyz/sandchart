import type { Icon } from "../icons";
import { hasRing, restoreFocus } from "../focus";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export interface MenuItem {
  id: string;
  label: string;
  /** None: an empty slot, so labels line up. */
  icon?: Icon;
  /** A choice among the items (`menuitemradio`): true for the one in force. */
  checked?: boolean;
  /** Shown on hover, e.g. why it is disabled. */
  title?: string;
  /** Shown on the right, e.g. "⌫". */
  shortcut?: string;
  /** `KeyboardEvent.key` values that pick it while the menu has focus. */
  keys?: readonly string[];
  disabled?: boolean;
  onSelect(): void;
}

export interface MenuProps {
  items: MenuItem[];
  /** Accessible name of the menu. */
  label: string;
  testId: string;
  /** The point it opens at, in px of its positioned parent (`fixed`: of the window). */
  x: number;
  y: number;
  /** Size of the area it must stay inside. */
  width: number;
  height: number;
  fixed?: boolean;
  onClose(): void;
}

const GAP = 2;
const MARGIN = 8;

/**
 * A small menu at a point: right of and below it when it fits, else flipped, never off
 * the area. Arrow keys, Home and End move between items, Enter or Space picks one, Esc,
 * Tab and a press outside close it. Focus moves to the first item when it opens and back
 * to where it was when it closes.
 */
export function Menu({ items, label, testId, x, y, width, height, fixed, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x + GAP, top: y + GAP });

  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const left = x + GAP + w <= width - MARGIN ? x + GAP : Math.max(MARGIN, x - GAP - w);
    const top = y + GAP + h <= height - MARGIN ? y + GAP : Math.max(MARGIN, y - GAP - h);
    setAt({ left, top });
  }, [x, y, width, height, items.length]);

  // On the next frame: the press that opened it would otherwise take focus back. On close,
  // focus goes back to where it was, unless it has moved on outside the menu.
  useEffect(() => {
    const before = document.activeElement;
    const ring = hasRing(before);
    const id = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus());
    const menu = ref.current;
    return () => {
      cancelAnimationFrame(id);
      const now = document.activeElement;
      const lost = now === null || now === document.body || menu?.contains(now) === true;
      if (lost && before instanceof HTMLElement) restoreFocus(before, ring);
    };
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // ⌘Z / ⇧⌘Z still reach the chart's shortcuts.
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") return;
    e.stopPropagation();
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i <= 0 ? list.length - 1 : i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
    } else {
      const item = items.find((it) => !it.disabled && it.keys?.includes(e.key));
      // Backspace would make WebKit go back a page.
      if (item || e.key === "Backspace") e.preventDefault();
      item?.onSelect();
    }
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={label}
      data-testid={testId}
      style={{ position: fixed ? "fixed" : "absolute", left: at.left, top: at.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            className="ctx-menu-item"
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            data-testid={`${testId}-${item.id}`}
            disabled={item.disabled}
            title={item.title}
            onClick={item.onSelect}
          >
            {Icon ? <Icon size={14} strokeWidth={1.75} aria-hidden="true" /> : <span className="ctx-menu-blank" aria-hidden="true" />}
            <span className="ctx-menu-label">{item.label}</span>
            {item.shortcut && <kbd className="ctx-menu-key">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
