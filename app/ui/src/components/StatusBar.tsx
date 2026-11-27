import type { ConnectionState } from "../backend/types";
import { t } from "../i18n";
import { version } from "../../package.json";

export interface StatusBarProps {
  source: string;
  connection: ConnectionState;
}

export function StatusBar({ source, connection }: StatusBarProps) {
  return (
    <footer className="statusbar mono" data-testid="status-bar">
      <span>{t("status.line", { source, state: t(`status.${connection}`) })}</span>
      <span className="spacer" />
      <span>{t("status.utc")}</span>
      <span>v{version}</span>
    </footer>
  );
}
