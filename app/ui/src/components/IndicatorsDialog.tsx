import { FileUp, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import { toProblem, type Backend, type FailedIndicator, type IndicatorInfo, type Inspection } from "../backend/types";
import { t } from "../i18n";
import type { IndicatorStore } from "../state/indicators";

/** The engine refuses bigger module files; checked here too, before the file is read. */
const MAX_FILE_MIB = 20;

export interface IndicatorsDialogProps {
  backend: Backend;
  store: IndicatorStore;
  onClose: () => void;
}

function Option({ info, onAdd, onRemove }: { info: IndicatorInfo; onAdd: () => void; onRemove?: () => void }) {
  const { meta } = info;
  return (
    <div className="ind-option-row">
      <button className="ind-option" data-testid="indicator-option" data-id={meta.id} onClick={onAdd}>
        <span className="name">{meta.name}</span>
        <span className="desc">{meta.description}</span>
        {!info.builtin && <span className="ver mono">{meta.version}</span>}
      </button>
      {onRemove && <RemoveButton name={meta.name} onRemove={onRemove} />}
    </div>
  );
}

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button className="icon-button" aria-label={`${t("indicators.remove")} ${name}`} title={t("indicators.remove")} onClick={onRemove}>
      <X size={14} />
    </button>
  );
}

/** A module that did not load: its id and why, and Remove for an installed one. */
function Failed({ failed, onRemove }: { failed: FailedIndicator; onRemove?: () => void }) {
  return (
    <div className="ind-option-row" data-testid="indicator-failed" data-id={failed.id}>
      <div className="ind-option failed">
        <span className="name mono">{failed.id}</span>
        <span className="desc" title={failed.error}>
          {t("indicators.notLoaded", { error: failed.error })}
        </span>
      </div>
      {onRemove && <RemoveButton name={failed.id} onRemove={onRemove} />}
    </div>
  );
}

/**
 * The indicator list: a click puts one on the chart (the dialog stays open), a module
 * file is checked and installed from here, with an in-dialog confirm before a replace
 * and before an uninstall. Modules that did not load are listed with the reason.
 */
export function IndicatorsDialog({ backend, store, onClose }: IndicatorsDialogProps) {
  useSyncExternalStore(store.subscribe, store.version);
  const state = store.state;
  const [confirm, setConfirm] = useState<{ bytes: Uint8Array; inspection: Inspection } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // A failed load is retried each time the dialog opens; the Retry button does it again.
  const reload = () => void state.load().catch(() => undefined); // shown from `state.loadError`
  useEffect(() => {
    if (state.loadError !== null) reload();
  }, []);

  // Escape is caught on the window: WebKit does not focus a button on click, so after a
  // click focus sits on <body> and a keydown never reaches the dialog element.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus moves into the dialog and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => before?.focus();
  }, []);

  /** Runs a backend job; its failure is shown in the dialog. */
  const run = async (job: () => Promise<void>, fileError = false) => {
    setError(null);
    setBusy(true);
    try {
      await job();
    } catch (e) {
      const message = toProblem(e).message;
      setError(fileError ? t("indicators.invalidFile", { error: message }) : message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so that picking the same file again fires `change` again.
    e.target.value = "";
    setConfirm(null);
    setRemoving(null);
    if (!file) return;
    if (file.size > MAX_FILE_MIB * 1024 * 1024) {
      setError(t("indicators.tooLarge", { mib: MAX_FILE_MIB }));
      return;
    }
    void run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inspection = await backend.inspectIndicator(bytes);
      if (inspection.replaces !== null) setConfirm({ bytes, inspection });
      else await state.install(bytes);
    }, true);
  };

  const builtin = state.infos.filter((i) => i.builtin);
  const installed = state.infos.filter((i) => !i.builtin);
  const failedBuiltin = state.failed.filter((f) => f.builtin);
  const failedInstalled = state.failed.filter((f) => !f.builtin);
  const askRemove = (id: string, name: string) => {
    setConfirm(null);
    setRemoving({ id, name });
  };
  const add = (id: string) => void run(() => state.add(id));

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className="ind-dialog"
        data-testid="indicators-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("indicators.button")}
      >
        <div className="ind-dialog-header">
          <span>{t("indicators.button")}</span>
          <button className="icon-button" aria-label={t("indicators.close")} title={t("indicators.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {state.loadError !== null && (
          <div className="ind-dialog-error" data-testid="indicator-load-error" role="alert">
            <span>{t("indicators.loadFailed", { error: state.loadError })}</span>
            <button className="text-button" onClick={reload}>
              {t("indicators.retry")}
            </button>
          </div>
        )}
        {state.serviceError !== null && (
          <div className="ind-dialog-error" data-testid="indicator-service-error" role="alert">
            {t("indicators.loadFailed", { error: state.serviceError })}
          </div>
        )}
        <div className="ind-dialog-body">
          <div className="ind-section">{t("indicators.builtin")}</div>
          {builtin.map((info) => (
            <Option key={info.meta.id} info={info} onAdd={() => add(info.meta.id)} />
          ))}
          {failedBuiltin.map((f) => (
            <Failed key={f.id} failed={f} />
          ))}
          {installed.length + failedInstalled.length > 0 && <div className="ind-section">{t("indicators.installed")}</div>}
          {installed.map((info) => (
            <Option
              key={info.meta.id}
              info={info}
              onAdd={() => add(info.meta.id)}
              onRemove={() => askRemove(info.meta.id, info.meta.name)}
            />
          ))}
          {failedInstalled.map((f) => (
            <Failed key={f.id} failed={f} onRemove={() => askRemove(f.id, f.id)} />
          ))}
        </div>
        {removing && (
          <div className="ind-confirm" data-testid="indicator-remove" role="alert">
            <span>{t("indicators.removeAsk", { name: removing.name })}</span>
            <button className="text-button" onClick={() => setRemoving(null)}>
              {t("indicators.cancel")}
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                const id = removing.id;
                setRemoving(null);
                void run(() => state.uninstall(id));
              }}
            >
              {t("indicators.remove")}
            </button>
          </div>
        )}
        {confirm && (
          <div className="ind-confirm" data-testid="indicator-replace" role="alert">
            <span>
              {t("indicators.replace", {
                name: confirm.inspection.meta.name,
                old: confirm.inspection.replaces ?? "",
                new: confirm.inspection.meta.version,
              })}
            </span>
            <button className="text-button" onClick={() => setConfirm(null)}>
              {t("indicators.cancel")}
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                const bytes = confirm.bytes;
                setConfirm(null);
                void run(() => state.install(bytes), true);
              }}
            >
              {t("indicators.replaceConfirm")}
            </button>
          </div>
        )}
        {error && (
          <div className="ind-dialog-error" data-testid="indicator-dialog-error" role="alert">
            {error}
          </div>
        )}
        <div className="ind-dialog-footer">
          <button className="text-button with-icon" disabled={busy} onClick={() => fileRef.current?.click()}>
            <FileUp size={14} />
            {t("indicators.addFromFile")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".wasm"
            hidden
            data-testid="indicator-file"
            aria-label={t("indicators.addFromFile")}
            onChange={onFile}
          />
          <span className="note">{t("indicators.sandboxNote")}</span>
        </div>
      </div>
    </div>
  );
}
