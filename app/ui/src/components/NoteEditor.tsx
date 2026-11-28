import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TextEdit } from "../chart/drawings/layer";
import { clampNoteText, NOTE_MAX_BYTES, noteBytes } from "../chart/drawings/tools/note";
import { t } from "../i18n";
import { shortcutLabel } from "../labels";

export interface NoteEditorProps {
  edit: TextEdit;
  hostWidth: number;
  hostHeight: number;
  onSave(text: string): void;
  onCancel(): void;
  onDelete(): void;
}

const WIDTH = 280;
/** Gap between the note's marker and the popover. */
const GAP = 12;

/**
 * The text of a note in a small dialog next to its marker: ⌘Enter (Ctrl+Enter) saves,
 * Esc cancels, Tab stays inside. The text is kept within the engine's byte limit.
 */
export function NoteEditor({ edit, hostWidth, hostHeight, onSave, onCancel, onDelete }: NoteEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(edit.text);
  const [top, setTop] = useState(edit.y + GAP);
  const left = Math.min(Math.max(8, edit.x - 24), Math.max(8, hostWidth - WIDTH - 8));

  // Below the marker when it fits, else above it, never off the chart.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    const below = edit.y + GAP;
    setTop(below + h <= hostHeight - 8 ? below : Math.max(8, edit.y - GAP - h));
  }, [edit.y, hostHeight]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // A press outside closes it without saving.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onCancel]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      onSave(text);
    } else if (e.key === "Tab") {
      // Focus stays in the dialog.
      const items = [...(ref.current?.querySelectorAll<HTMLElement>("textarea, button:not(:disabled)") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next]?.focus();
    }
  };

  const bytes = noteBytes(text);
  return (
    <div
      ref={ref}
      className="note-editor"
      data-testid="note-editor"
      role="dialog"
      aria-modal="true"
      aria-label={t("note.title")}
      style={{ top, left, width: WIDTH }}
      onKeyDown={onKeyDown}
    >
      <textarea
        ref={area}
        aria-label={t("note.text")}
        placeholder={t("note.placeholder")}
        value={text}
        rows={4}
        onChange={(e) => setText(clampNoteText(e.target.value))}
      />
      <div className="note-editor-footer">
        <span className="note-editor-bytes mono" aria-live="polite" data-full={bytes >= NOTE_MAX_BYTES}>
          {t("note.bytes", { n: bytes, max: NOTE_MAX_BYTES })}
        </span>
        {!edit.isNew && (
          <button className="text-button" data-testid="note-delete" onClick={onDelete}>
            {t("note.delete")}
          </button>
        )}
        <button className="text-button" data-testid="note-cancel" onClick={onCancel}>
          {t("note.cancel")}
        </button>
        <button
          className="primary-button"
          data-testid="note-save"
          title={t("note.saveHint", { shortcut: shortcutLabel("Enter") })}
          onClick={() => onSave(text)}
        >
          {t("note.save")}
        </button>
      </div>
    </div>
  );
}
