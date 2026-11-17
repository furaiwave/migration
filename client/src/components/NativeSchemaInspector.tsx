import { useState } from "react";
import { translate } from "@/i18n";
import { apiRequest, type ApiRoutes } from "@/client/client";
import { useApiMutation } from "@/hooks/useApiMutation";
import { errorMessage } from "@/lib/errors";
import { logActivity } from "@/lib/activityLog";
import { Button } from "./ui/button";
type Settings = ApiRoutes["POST /dbf/native/inspect"]["body"];
const inspect = (connection: Settings) =>
  apiRequest("POST /dbf/native/inspect", { body: connection });
export function NativeSchemaInspector({
  connection,
  disabled = false,
}: {
  connection: Settings;
  disabled?: boolean;
}) {
  const run = useApiMutation(inspect);
  // This snapshot stays only in memory; it is never included in the downloadable metadata report.
  const [requested, setRequested] = useState<string | null>(null);
  const current = requested === JSON.stringify(connection);
  const load = () => {
    setRequested(JSON.stringify(connection));
    void run
      .mutate(connection)
      .then((report) =>
        logActivity(
          "DB",
          report.database,
          report.truncated ? "WARNING" : "DONE",
          "Read database structure; " + report.objects.length + " objects",
        ),
      )
      .catch(() => {});
  };
  const download = () => {
    if (run.state.status !== "success" || !current) return;
    const report = run.state.data;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2) + "\n"], {
        type: "application/json;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download =
      "schema-" +
      (report.database.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) ||
        "database") +
      ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const report =
    current && run.state.status === "success" ? run.state.data : null;
  const ready =
    connection.engine === "mongo"
      ? !!connection.uri?.trim()
      : !!connection.host?.trim() &&
        !!connection.user?.trim() &&
        !!connection.database?.trim() &&
        Number.isInteger(connection.port) &&
        Number(connection.port) > 0 &&
        Number(connection.port) <= 65535;
  return (
    <section
      className="flex flex-col gap-2 border p-3"
      aria-label={translate("Destination database structure")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold">
          {translate("Destination database structure")}
        </h4>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || run.isPending || !ready}
          onClick={load}
        >
          {run.isPending
            ? translate("Checking…")
            : translate("View structure")}
        </Button>
        {report && (
          <Button size="sm" variant="outline" onClick={download}>
            {translate("Download structure .json")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          "Reads metadata only. Table rows and documents are not loaded.",
        )}
      </p>
      {current && run.state.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(run.state.error)}
        </p>
      )}
      {report && (
        <div className="flex flex-col gap-2 text-xs" role="status">
          <p>
            {report.database} ·{" "}
            {translate("Objects: {0}", [report.objects.length])} ·{" "}
            {translate("Check time: {0} ms", [report.elapsedMs])}
          </p>
          {report.truncated && (
            <p className="text-amber-600">
              {translate(
                "The structure is partial because of the report size limit.",
              )}
            </p>
          )}
          {!report.objects.length && (
            <p>{translate("No accessible objects found.")}</p>
          )}
          <div className="max-h-80 overflow-auto">
            {report.objects.map((object) => (
              <details
                key={JSON.stringify([object.schema, object.name])}
                className="border-t py-2"
              >
                <summary className="cursor-pointer font-mono">
                  {object.schema}.{object.name} · {object.kind}
                </summary>
                {object.columns.length > 0 && (
                  <table className="w-full text-left">
                    <thead>
                      <tr>
                        <th>{translate("Column (mapping)")}</th>
                        <th>{translate("Type")}</th>
                        <th>NULL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {object.columns.map((column) => (
                        <tr key={column.ordinal}>
                          <td className="py-1">{column.name}</td>
                          <td className="font-mono">{column.dataType}</td>
                          <td>{column.nullable ? "YES" : "NO"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
