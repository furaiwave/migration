import {
  ArrowDownRight,
  Check,
  Database,
  FileText,
  GitBranch,
  Rows3,
} from "lucide-react";
import { getLanguage, translate } from "@/i18n";
import { useNativeTarget } from "@/lib/nativeTarget";
import type {
  ParseMultipleResult,
  DbfRelationshipGraph,
} from "@/api/api.types";
const LABELS = {
  redis: "Redis",
  mysql: "MySQL",
  mongo: "MongoDB",
  postgres: "PostgreSQL",
  mssql: "MSSQL",
};
function savedEngine(): keyof typeof LABELS {
  try {
    const value = localStorage.getItem("dbf-inspector:export-target");
    if (value && Object.hasOwn(LABELS, value)) return value as keyof typeof LABELS;
  } catch {
    /* Storage unavailable. */
  }
  return "mysql";
}
export function WorkspaceOverview({
  session,
  graph,
  working,
}: {
  session: ParseMultipleResult | null;
  graph: DbfRelationshipGraph | null;
  working: boolean;
}) {
  const target = useNativeTarget();
  const engine = target.active ?? savedEngine();
  const server = target.servers[engine];
  const records =
    session?.files.reduce((count, file) => count + file.totalRecords, 0) ?? 0;
  const links =
    graph?.relationships.filter((link) => !link.disabled).length ?? 0;
  const format = (value: number) => value.toLocaleString(getLanguage());
  const steps = [
    {
      number: "01",
      label: translate("Database"),
      detail: translate("Optional"),
      href: "#destination",
      enabled: true,
      done: !!server,
    },
    {
      number: "02",
      label: translate("Source data"),
      detail: session
        ? translate("Session opened")
        : translate("Choose files"),
      href: "#source",
      enabled: true,
      done: !!session,
    },
    {
      number: "03",
      label: translate("Verification"),
      detail: session ? translate("Relationships") : translate("After uploading"),
      href: "#review",
      enabled: !!session,
      done: false,
    },
    {
      number: "04",
      label: translate("Transfer"),
      detail: session ? LABELS[engine] : translate("After uploading"),
      href: "#transfer",
      enabled: !!session,
      done: false,
    },
  ];
  return (
    <div className="workspace-overview">
      <div className="workspace-intro">
        <div>
          <p className="workspace-eyebrow">Tables / MIGRATION WORKSPACE</p>
          <h2>{translate("Data migration")}</h2>
          <p className="workspace-description">
            {translate(
              "Add tables, review the data and choose a destination database.",
            )}
          </p>
        </div>
        <span className={"workspace-status " + (session ? "is-ready" : "")}>
          <span
            className={
              working
                ? "workspace-status-dot is-working"
                : "workspace-status-dot"
            }
          />
          {working
            ? translate("Uploading and reading…")
            : session
              ? translate("Session opened")
              : translate("Waiting for files")}
        </span>
      </div>
      <nav className="workspace-steps" aria-label={translate("Workflow")}>
        {steps.map((step) => (
          <a
            key={step.number}
            href={step.enabled ? step.href : undefined}
            aria-disabled={!step.enabled}
            className={
              step.enabled ? "workspace-step" : "workspace-step is-disabled"
            }
          >
            <span
              className={
                "workspace-step-number " + (step.done ? "is-done" : "")
              }
            >
              {step.done ? <Check size={14} /> : step.number}
            </span>
            <span>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
            {step.enabled && (
              <ArrowDownRight size={14} className="workspace-step-arrow" />
            )}
          </a>
        ))}
      </nav>
      {session && (
        <div
          className="workspace-metrics"
          aria-label={translate("Session summary")}
        >
          {[
            {
              icon: FileText,
              label: translate("Tables"),
              value: format(session.files.length),
            },
            {
              icon: Rows3,
              label: translate("Records (count)"),
              value: format(records),
            },
            {
              icon: GitBranch,
              label: translate("Active relationships"),
              value: format(links),
            },
            {
              icon: Database,
              label: translate("Destination DBMS"),
              value: LABELS[engine],
            },
          ].map((metric) => (
            <div key={metric.label} className="workspace-metric">
              <span>
                <metric.icon size={14} />
                {metric.label}
              </span>
              <strong>{metric.value}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
