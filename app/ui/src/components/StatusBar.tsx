import type { ConnectionState } from "../backend/types";
import { t } from "../i18n";
import type { UpdateStore } from "../state/update";
import { UpdateBanner } from "./UpdateBanner";
import { VersionPopover } from "./VersionPopover";

export interface StatusBarProps {
  source: string;
  connection: ConnectionState;
  updates: UpdateStore;
}

export function StatusBar({ source, connection, updates }: StatusBarProps) {
  return (
    <footer className="statusbar mono" data-testid="status-bar">
      <span>{t("status.line", { source, state: t(`status.${connection}`) })}</span>
      <span className="spacer" />
      <UpdateBanner store={updates} />
      <span>{t("status.utc")}</span>
      <VersionPopover store={updates} />
    </footer>
  );
}
