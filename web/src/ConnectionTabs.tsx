import { useT } from "./i18n";

export type ConnectionTabItem = {
  id: string;
  label: string;
  connected?: boolean;
  connecting?: boolean;
};

/** Server tab strip for multi-join: one tab per open connection. */
export function ConnectionTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
}: {
  tabs: ConnectionTabItem[];
  activeTabId?: string | null;
  onSelectTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
}) {
  const t = useT();
  return (
    <div
      className="gts-connection-tabs"
      role="tablist"
      aria-label={t("tabs.connections")}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === (activeTabId ?? tabs[0]?.id);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={`gts-connection-tab${isActive ? " gts-connection-tab-active" : ""}${
              tab.connecting ? " gts-connection-tab-connecting" : ""
            }`}
            onClick={() => onSelectTab?.(tab.id)}
            tabIndex={0}
            aria-keyshortcuts={onCloseTab ? "Delete" : undefined}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              // The × below is mouse-only (a button can't sit inside a tab); Delete closes.
              if (e.key === "Delete" && onCloseTab) onCloseTab(tab.id);
              else if (e.key === "Enter" || e.key === " ")
                onSelectTab?.(tab.id);
              else return;
              e.preventDefault();
            }}
            title={tab.label}
          >
            <span className="gts-connection-tab-label">{tab.label}</span>
            {onCloseTab ? (
              <span
                className="gts-connection-tab-close"
                aria-hidden="true"
                title={t("tabs.disconnect")}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                ×
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
