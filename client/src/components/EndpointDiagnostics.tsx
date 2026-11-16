import { translate } from "@/i18n";
import { apiRequest } from "@/client/client";
import { useApiMutation } from "@/hooks/useApiMutation";
import { errorMessage } from "@/lib/errors";
import { logActivity } from "@/lib/activityLog";
import type { NativeDiagnostic } from "@/api/api.types";
import { Button } from "./ui/button";
const diagnose = (endpoint: { host: string; port: number }) =>
  apiRequest("POST /dbf/native/diagnose", { body: endpoint });
function statusLabel(status: NativeDiagnostic["status"]): string {
  switch (status) {
    case "reachable":
      return translate("Порт відкрито");
    case "refused":
      return translate("Сервер відхилив TCP-з’єднання");
    case "dnsError":
      return translate("Не вдалося визначити IP-адресу");
    case "dnsTimeout":
      return translate("Час очікування DNS вичерпано");
    case "timeout":
      return translate("Час очікування TCP вичерпано");
    default:
      return translate("Сервер недоступний через мережу");
  }
}
export function EndpointDiagnostics({
  host,
  port,
}: {
  host: string;
  port: number;
}) {
  const run = useApiMutation(diagnose);
  const check = () => {
    void run
      .mutate({ host, port })
      .then((result) =>
        logActivity(
          "DB",
          host + ":" + port,
          result.status === "reachable" ? "DONE" : "WARNING",
          "Network diagnostic: " +
            result.status +
            "; " +
            result.elapsedMs +
            " ms",
        ),
      )
      .catch(() => {});
  };
  return (
    <div className="flex flex-col gap-2 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={run.isPending}
        onClick={check}
      >
        {run.isPending
          ? translate("Перевіряю…")
          : translate("Діагностика мережі")}
      </Button>
      {run.state.status === "success" && (
        <p
          role="status"
          className={
            run.state.data.status === "reachable"
              ? "text-emerald-600"
              : "text-amber-600"
          }
        >
          {statusLabel(run.state.data.status)} ·{" "}
          {translate("Час перевірки: {0} мс", [run.state.data.elapsedMs])}
          {run.state.data.resolvedAddresses.length > 0
            ? " · " +
              translate("Адреси: {0}", [
                run.state.data.resolvedAddresses.join(", "),
              ])
            : ""}
        </p>
      )}
      {run.state.status === "error" && (
        <p role="alert" className="text-destructive">
          {errorMessage(run.state.error)}
        </p>
      )}
    </div>
  );
}
