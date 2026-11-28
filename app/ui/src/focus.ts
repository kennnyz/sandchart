/**
 * Focus goes back to `el` (the control that opened a menu or dialog) when that closes. It shows
 * a focus ring only when `el` had one when it opened it, that is when it was reached from the
 * keyboard: a control clicked with the mouse gets focus back without a ring, also when the
 * menu was closed with Esc. The mark goes once focus leaves it.
 */
export function restoreFocus(el: HTMLElement, ring: boolean): void {
  if (!el.isConnected) return;
  if (!ring) {
    el.dataset.noRing = "";
    el.addEventListener("blur", () => delete el.dataset.noRing, { once: true });
  }
  el.focus();
}

/** Whether `el` shows a focus ring now (it was reached from the keyboard). */
export function hasRing(el: Element | null): boolean {
  try {
    return el?.matches(":focus-visible") === true;
  } catch {
    return false;
  }
}

/**
 * A button pressed with the mouse (or a touch) shows no focus ring while it keeps the focus,
 * even when a key is pressed next (browsers show the ring on the first key otherwise). A
 * button reached with Tab still shows it. Returns the function that removes the listener.
 */
export function markPointerFocus(doc: Document = document): () => void {
  const onDown = (e: PointerEvent) => {
    const b = e.target instanceof Element ? e.target.closest("button") : null;
    if (!(b instanceof HTMLElement) || "noRing" in b.dataset) return;
    b.dataset.noRing = "";
    b.addEventListener("blur", () => delete b.dataset.noRing, { once: true });
  };
  doc.addEventListener("pointerdown", onDown, true);
  return () => doc.removeEventListener("pointerdown", onDown, true);
}
