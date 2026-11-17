import { BINARY_DUMP_MESSAGE, isBinarySqlDump, parseSqlDump, type DumpDialect } from "./sqlDump";

type DumpRequest = { file: File; dialect?: DumpDialect | "auto" };

self.onmessage = async (event: MessageEvent<File | DumpRequest>) => {
  try {
    const request: DumpRequest = "file" in event.data ? event.data : { file: event.data };
    const { file, dialect } = request;
    if (file.size > 50 * 1024 * 1024) {
      self.postMessage({ error: "The SQL dump exceeds the 50 MB limit. Export the schema without data." });
      return;
    }
    const buffer = await file.arrayBuffer();
    if (isBinarySqlDump(new Uint8Array(buffer))) {
      self.postMessage({ error: BINARY_DUMP_MESSAGE });
      return;
    }
    let sql: string;
    try {
      sql = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      self.postMessage({ error: "The SQL dump is not valid UTF-8. Export it as UTF-8 and try again." });
      return;
    }
    self.postMessage({ schema: parseSqlDump(sql, dialect === "auto" ? undefined : dialect) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Could not read SQL dump." });
  }
};
