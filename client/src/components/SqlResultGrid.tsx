import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowDown, ArrowUp, Copy, Download, X } from "lucide-react";
import { translate, useLanguage } from "@/i18n";
import type { QuerySet } from "@/api/sql-editor.types";
import { compareValues, downloadText, resultCsv } from "@/lib/sqlEditor";
import { Button } from "./ui/button";
const ROW = 30,
  COLUMN = 180,
  GUTTER = 48;
export const SqlResultGrid = memo(function SqlResultGrid({
  result,
}: {
  result: QuerySet;
}) {
  useLanguage();
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [scroll, setScroll] = useState({
    top: 0,
    left: 0,
    width: 800,
    height: 360,
  });
  const [filter, setFilter] = useState("");
  const deferred = useDeferredValue(filter);
  const [sort, setSort] = useState<{ column: number; desc: boolean } | null>(
    null,
  );
  const [cell, setCell] = useState<{
    column: string;
    value: string | null;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box)
        setScroll((value) => ({
          ...value,
          width: box.width,
          height: box.height,
        }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (cell) dialog.current?.showModal();
  }, [cell]);
  const rows = useMemo(() => {
    const query = deferred.toLowerCase().trim();
    const indices = result.rows.flatMap((row, i) =>
      !query || row.some((value) => value?.toLowerCase().includes(query))
        ? [i]
        : [],
    );
    if (sort)
      indices.sort(
        (a, b) =>
          compareValues(
            result.rows[a][sort.column],
            result.rows[b][sort.column],
          ) * (sort.desc ? -1 : 1),
      );
    return indices;
  }, [result, deferred, sort]);
  const rowStart = Math.max(0, Math.floor((scroll.top - ROW) / ROW) - 6);
  const rowEnd = Math.min(
    rows.length,
    rowStart + Math.ceil(scroll.height / ROW) + 14,
  );
  const colStart = Math.max(0, Math.floor((scroll.left - GUTTER) / COLUMN) - 2);
  const colEnd = Math.min(
    result.columns.length,
    colStart + Math.ceil(scroll.width / COLUMN) + 5,
  );
  const width = GUTTER + result.columns.length * COLUMN;
  const columns = result.columns.slice(colStart, colEnd);
  const close = () => {
    dialog.current?.close();
    setCell(null);
    setCopied(false);
  };
  return (
    <div className="sql-results">
      <div className="sql-result-tools">
        <label>
          {translate("Filter results")}
          <input
            type="search"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              if (viewport.current) viewport.current.scrollTop = 0;
              setScroll((v) => ({ ...v, top: 0 }));
            }}
          />
        </label>
        <span>
          {rows.length} / {result.rows.length} {translate("Rows")}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            downloadText(
              "query-result.csv",
              resultCsv(result),
              "text/csv;charset=utf-8",
            )
          }
        >
          <Download /> CSV
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            downloadText(
              "query-result.json",
              JSON.stringify(
                { columns: result.columns, rows: result.rows },
                null,
                2,
              ),
              "application/json",
            )
          }
        >
          <Download /> JSON
        </Button>
      </div>
      {(result.truncated || result.clipped) && (
        <p className="sql-notice">
          {translate(
            result.clipped
              ? "Some values or columns were shortened."
              : "The result limit was reached. Add a WHERE clause or increase the row limit.",
          )}
        </p>
      )}
      {!result.columns.length ? (
        <div className="sql-empty-result">
          {translate("Query completed")}
          {result.affectedRows !== null && (
            <>
              {" "}
              · {translate("Affected rows")}: {result.affectedRows}
            </>
          )}
        </div>
      ) : (
        <div
          ref={viewport}
          className="sql-grid-viewport"
          role="grid"
          aria-label={translate("Query results")}
          aria-rowcount={rows.length + 1}
          aria-colcount={result.columns.length + 1}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop,
              left = e.currentTarget.scrollLeft;
            setScroll((value) => ({ ...value, top, left }));
          }}
        >
          <div className="sql-grid-header" role="row" style={{ width }}>
            <span className="sql-grid-number" role="columnheader">
              #
            </span>
            {columns.map((column, i) => {
              const index = colStart + i;
              return (
                <button
                  key={index}
                  role="columnheader"
                  aria-colindex={index + 2}
                  aria-sort={
                    sort?.column === index
                      ? sort.desc
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                  style={{ left: GUTTER + index * COLUMN, width: COLUMN }}
                  title={column.dataType}
                  onClick={() =>
                    setSort((value) => ({
                      column: index,
                      desc: value?.column === index ? !value.desc : false,
                    }))
                  }
                >
                  <span>{column.name}</span>
                  {sort?.column === index &&
                    (sort.desc ? (
                      <ArrowDown size={12} />
                    ) : (
                      <ArrowUp size={12} />
                    ))}
                  {column.dataType && <small>{column.dataType}</small>}
                </button>
              );
            })}
          </div>
          <div
            style={{ height: rows.length * ROW, width, position: "relative" }}
          >
            {rows.slice(rowStart, rowEnd).map((source, i) => {
              const index = rowStart + i,
                row = result.rows[source];
              return (
                <div
                  role="row"
                  aria-rowindex={index + 2}
                  className="sql-grid-row"
                  key={source}
                  style={{ top: index * ROW, width, height: ROW }}
                >
                  <span className="sql-grid-number" role="rowheader">
                    {source + 1}
                  </span>
                  {columns.map((column, j) => {
                    const c = colStart + j,
                      value = row[c];
                    return (
                      <button
                        key={c}
                        role="gridcell"
                        aria-colindex={c + 2}
                        className={value === null ? "is-null" : ""}
                        style={{ left: GUTTER + c * COLUMN, width: COLUMN }}
                        title={value === null ? "NULL" : value.slice(0, 256)}
                        onDoubleClick={() =>
                          setCell({ column: column.name, value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            setCell({ column: column.name, value });
                          }
                        }}
                      >
                        {value === null ? (
                          <em>NULL</em>
                        ) : value === "" ? (
                          <span className="sql-empty-string">""</span>
                        ) : (
                          value
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {!rows.length && (
            <p className="sql-empty-result">{translate("No rows returned")}</p>
          )}
        </div>
      )}
      <dialog
        ref={dialog}
        className="sql-value-dialog"
        onCancel={() => {
          setCell(null);
          setCopied(false);
        }}
      >
        <div>
          <strong>{cell?.column}</strong>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translate("Close")}
            onClick={close}
          >
            <X />
          </Button>
        </div>
        <textarea
          aria-label={translate("Cell value")}
          readOnly
          value={cell?.value ?? "NULL"}
          spellCheck={false}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(cell?.value ?? "NULL")
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          <Copy />
          {translate(copied ? "Copied" : "Copy")}
        </Button>
      </dialog>
    </div>
  );
});
