import { ArrowRight, ArrowRightLeft, ArrowUpRight, Files } from "lucide-react";
import { translate } from "@/i18n";
import {
  followWorkspaceLink,
  workspaceHref,
  type WorkspacePage,
} from "@/lib/workspaceNavigation";

const workflows = [
  {
    page: "files",
    icon: Files,
    title: "Table files",
    from: "Table files",
    to: "Database",
    description:
      "Add tables, review the data and choose a destination database.",
  },
  {
    page: "transfer",
    icon: ArrowRightLeft,
    title: "Between databases",
    from: "Source",
    to: "Destination",
    description:
      "Copy selected tables, collections or keys between database servers.",
  },
  {
    page: "upgrade",
    icon: ArrowUpRight,
    title: "Version upgrade",
    from: "Old server",
    to: "New server",
    description:
      "Move data from an old server to a newer version of the same database engine.",
  },
] as const;
export function WorkspaceHome({
  locked,
  onNavigate,
}: {
  locked: boolean;
  onNavigate: (page: WorkspacePage) => void;
}) {
  return (
    <section className="workspace-home" aria-labelledby="workspace-home-title">
      <div className="workspace-home-heading">
        <p className="workspace-eyebrow">DATA MIGRATOR</p>
        <h2 id="workspace-home-title">{translate("Choose a migration")}</h2>
        <p className="workspace-description">
          {translate("Choose what to move and where to send it.")}
        </p>
      </div>
      <div className="workspace-scenarios">
        {workflows.map(({ page, icon: Icon, title, from, to, description }) => (
          <a
            key={page}
            href={workspaceHref(page)}
            className="workspace-scenario"
            data-workflow={page}
            aria-disabled={locked || undefined}
            tabIndex={locked ? -1 : undefined}
            onClick={(event) =>
              followWorkspaceLink(event, page, locked, onNavigate)
            }
          >
            <span className="workspace-scenario-icon">
              <Icon aria-hidden="true" />
            </span>
            <h3>{translate(title)}</h3>
            <p className="workspace-scenario-description">
              {translate(description)}
            </p>
            <div className="workspace-scenario-flow">
              <span>{translate(from)}</span>
              <ArrowRight aria-hidden="true" />
              <span>{translate(to)}</span>
            </div>
            <span className="workspace-scenario-action">
              {translate("Open workspace")}
              <ArrowRight aria-hidden="true" />
            </span>
          </a>
        ))}
      </div>
      <div className="workspace-engine-list" aria-label={translate("Database")}>
        {[
          "MySQL / MariaDB",
          "MongoDB",
          "PostgreSQL",
          "Microsoft SQL Server",
          "Redis",
        ].map((engine) => (
          <span key={engine}>{engine}</span>
        ))}
      </div>
    </section>
  );
}
