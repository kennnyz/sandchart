import { useEffect, type RefObject } from "react";

/**
 * Closes a popover on Escape and on a press outside `ref`. Escape is caught on the window:
 * WebKit does not focus a button on click, so focus sits on <body> and a keydown never
 * reaches the popover.
 */
export function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close, ref]);
}
