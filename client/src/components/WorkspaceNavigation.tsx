import {
  ArrowRightLeft,
  ArrowUpRight,
  Files,
  House,
  SquareTerminal,
  FileCode2,
} from "lucide-react";
import { translate } from "@/i18n";
import {
  followWorkspaceLink,
  workspaceHref,
  type WorkspacePage,
} from "@/lib/workspaceNavigation";

const destinations = [
  { page: "home", icon: House, label: "Home" },
  { page: "files", icon: Files, label: "Table files" },
  { page: "transfer", icon: ArrowRightLeft, label: "Between databases" },
  { page: "upgrade", icon: ArrowUpRight, label: "Version upgrade" },
  { page: "editor", icon: SquareTerminal, label: "SQL editor" },
  { page: "dump", icon: FileCode2, label: "SQL dump" },
] as const;
export function WorkspaceNavigation({
  page,
  locked,
  onNavigate,
}: {
  page: WorkspacePage;
  locked: boolean;
  onNavigate: (page: WorkspacePage) => void;
}) {
  return (
    <div className="workspace-navigation-shell">
      <nav
        className="workspace-navigation"
        aria-label={translate("Main navigation")}
      >
        {destinations.map(({ page: next, icon: Icon, label }) => (
          <a
            key={next}
            href={workspaceHref(next)}
            data-workspace-link={next}
            aria-current={page === next ? "page" : undefined}
            aria-disabled={locked || undefined}
            tabIndex={locked ? -1 : undefined}
            onClick={(event) =>
              followWorkspaceLink(event, next, locked, onNavigate)
            }
          >
            <Icon aria-hidden="true" /> <span>{translate(label)}</span>
          </a>
        ))}
      </nav>
      {locked && (
        <p role="status" className="workspace-navigation-notice">
          {translate(
            "Navigation is available after the current operation finishes.",
          )}
        </p>
      )}
    </div>
  );
}
