/** User-facing operation names; transport paths remain an implementation detail. */
export function operationLabel(route: string): string {
  const method = route.slice(0, route.indexOf(" "));
  const path = route.slice(route.indexOf(" ") + 1);
  if (path.includes("parse-multiple")) return "Read source files";
  if (path.endsWith("/plan")) return "Build transfer plan";
  if (path.endsWith("/export")) return "Download export";
  if (path.endsWith("/test-connection")) return "Test connection";
  if (path.endsWith("/diagnose")) return "Run network diagnostics";
  if (path.endsWith("/catalog")) return "Load database catalog";
  if (path.endsWith("/query")) return "Run SQL";
  if (path.endsWith("/inspect")) return "Inspect database structure";
  if (path.endsWith("/servers")) return "Find database servers";
  if (path.includes("/encoding")) return "Change source encoding";
  if (path.includes("/relationship")) return "Update relationships";
  if (path.includes("/jobs/") || path.includes("/import/"))
    return method === "DELETE" ? "Stop transfer" : "Read transfer status";
  if (path.endsWith("/start") || path.endsWith("/import")) return "Start transfer";
  if (path.includes("/session/"))
    return method === "DELETE" ? "Close source session" : "Read source session";
  return "Process data request";
}
