import { EndpointDiagnostics } from "./EndpointDiagnostics";
import { useState } from "react";
import { translate } from "@/i18n";
import { apiRequest, CLOUD_APP } from "@/client/client";
import { Button } from "./ui/button";
import { errorMessage } from "@/lib/errors";
import { logActivity } from "@/lib/activityLog";
import {
  selectNativeServer,
  useNativeTarget,
  type NativeServer,
} from "@/lib/nativeTarget";
export function DatabaseDiscovery() {
  const [servers, setServers] = useState<NativeServer[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [choice, setChoice] = useState("");
  const target = useNativeTarget();
  const selected = target.active ? target.servers[target.active] : null;
  const scan = () => {
    setPending(true);
    setError(null);
    logActivity(
      "DB",
      "system",
      "INFO",
      "Rust local database discovery started",
    );
    void apiRequest("GET /dbf/native/servers")
      .then((result) => {
        setServers(result.servers);
        setWarnings(result.warnings);
        setScanned(true);
        setChoice("");
        logActivity(
          "DB",
          "system",
          "DONE",
          "Discovered " + result.servers.length + " local database endpoints",
        );
      })
      .catch((err) => {
        setError(err);
        logActivity(
          "DB",
          "system",
          "ERROR",
          "Native database discovery failed",
        );
      })
      .finally(() => setPending(false));
  };
  const choose = () => {
    const server = servers.find((s) => s.id === choice);
    if (server) {
      selectNativeServer(server);
      logActivity(
        "DB",
        server.host + ":" + server.port,
        "INFO",
        "Selected " + server.label + " for future import",
      );
    }
  };
  return (
    <section
      className="workspace-destination"
      aria-label={translate("Пошук СУБД")}
    >
      <div className="workspace-destination-heading"><span className="workspace-step-index">01</span><span className="workspace-optional">{translate("Необов’язково")}</span></div>
      <div className="flex flex-col gap-3">
        <h2 className="workspace-destination-title">
          {translate("Сервер для майбутнього імпорту")}
        </h2>
        <Button size="sm" variant="outline" disabled={pending} onClick={scan}>
          {pending ? translate("Пошук…") : translate("Знайти СУБД у системі")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {translate(
          "Знайдений порт не підтверджує доступ до бази. Після вибору вкажіть облікові дані та перевірте з’єднання.",
        )}
      </p>
      {CLOUD_APP && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {translate("Пошук і підключення виконуються на хмарному сервері. Локальна СУБД вашого комп’ютера потребує мережевого доступу або VPN. localhost — це контейнер застосунку.")}
        </p>
      )}
      {servers.length > 0 && (
        <div className="flex flex-col items-stretch gap-2">
          <select
            aria-label={translate("Знайдені сервери")}
            className="h-10 w-full min-w-0 border bg-background px-2 text-xs"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">{translate("Виберіть сервер")}</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {s.host.includes(':')?'['+s.host+']':s.host}:{s.port} ·{" "}
                {s.protocolConfirmed
                  ? translate("СУБД відповідає")
                  : s.reachable
                    ? translate("Порт відкрито")
                    : translate("Недоступний")}{" "}

              </option>
            ))}
          </select>
          <Button size="sm" disabled={!choice} onClick={choose}>
            {translate("Використати для імпорту")}
          </Button>
        </div>
      )}
      {scanned && !servers.length && (
        <p className="text-xs text-muted-foreground">
          {translate(
            "Локальні СУБД не знайдено. Можна вказати сервер вручну у формі імпорту.",
          )}
        </p>
      )}
      {selected && (
        <p className="workspace-selected-server">
          {translate("Вибрано: {0} · {1}:{2}", [
            selected.label,
            selected.host.includes(':')?'['+selected.host+']':selected.host,
            selected.port,
          ])}
        </p>
      )}
      {selected && (
        <EndpointDiagnostics
          key={JSON.stringify([selected.host, selected.port])}
          host={selected.host}
          port={selected.port}
        />
      )}
      {warnings.map((w, i) => (
        <p key={i} className="text-xs text-amber-600">
          {w}
        </p>
      ))}
      {error != null && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(error)}
        </p>
      )}
    </section>
  );
}
