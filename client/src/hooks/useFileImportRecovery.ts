import { useEffect, useState } from "react";
import {
  savedFileImportJob,
  forgetFileImportJob,
  type FileImportEngine,
} from "@/lib/fileImportJobs";
import { isMissingImportJob } from "@/lib/importPolling";
/** Each mounted import form is scoped to one session and one engine. Only its job reference is persisted. */
export function useFileImportRecovery<
  T extends { jobId: string; state: string },
>({
  sessionId,
  engine,
  job,
  load,
  onRestore,
}: {
  sessionId: string;
  engine: FileImportEngine;
  job: T | null;
  load: (jobId: string) => Promise<T>;
  onRestore: (job: T) => void;
}) {
  const [pending, setPending] = useState(() =>
    savedFileImportJob(sessionId, engine),
  );
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!pending) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restore = async () => {
      try {
        const result = await load(pending);
        if (disposed) return;
        if (
          !result ||
          result.jobId !== pending ||
          !["running", "done", "failed", "cancelled"].includes(result.state)
        )
          throw new Error("Invalid import status returned by the server");
        if (result.state !== "running")
          forgetFileImportJob(sessionId, engine, pending);
        onRestore(result);
        setError(null);
        setPending(null);
      } catch (cause) {
        if (disposed) return;
        if (isMissingImportJob(cause)) {
          forgetFileImportJob(sessionId, engine, pending);
          setMissing(true);
          setError(null);
          setPending(null);
        } else {
          setError(cause);
          timer = setTimeout(() => {
            void restore();
          }, 5000);
        }
      }
    };
    void restore();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, engine, pending, load, onRestore]);
  useEffect(() => {
    if (job && job.state !== "running")
      forgetFileImportJob(sessionId, engine, job.jobId);
  }, [sessionId, engine, job]);
  return { restoring: pending !== null, error, missing };
}
