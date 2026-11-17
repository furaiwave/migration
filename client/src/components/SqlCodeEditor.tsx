import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  sql,
  PostgreSQL,
  MySQL,
  MSSQL,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import type { EditorEngine } from "@/api/sql-editor.types";
import type { NativeSchema } from "@/api/api.types";

export interface SqlCodeHandle {
  getSql(): string;
  focus(): void;
}
interface Props {
  tabId: string;
  code: string;
  tabIds: string;
  engine: EditorEngine;
  schema: NativeSchema | null;
  onChange(id: string, sql: string): void;
  onRun(sql: string): void;
}
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--primary)" },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--editor-string)",
  },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--editor-number)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: tags.operator, color: "var(--foreground)" },
]);
function language(engine: EditorEngine, report: NativeSchema | null) {
  const names: Record<string, SQLNamespace> = Object.create(null) as Record<
    string,
    SQLNamespace
  >;
  for (const object of report?.objects ?? [])
    names[object.schema] ??= Object.create(null) as SQLNamespace;
  for (const object of report?.objects ?? []) {
    const namespace = (names[object.schema] ??= Object.create(null)) as Record<
      string,
      SQLNamespace
    >;
    namespace[object.name] = object.columns.map((column) => column.name);
    names[object.name] ??= object.columns.map((column) => column.name);
  }
  return sql({
    dialect:
      engine === "mysql" ? MySQL : engine === "mssql" ? MSSQL : PostgreSQL,
    schema: names,
    defaultSchema:
      engine === "postgres"
        ? "public"
        : engine === "mssql"
          ? "dbo"
          : report?.database,
    upperCaseKeywords: true,
  });
}
export const SqlCodeEditor = forwardRef<SqlCodeHandle, Props>(
  function SqlCodeEditor(props, ref) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const latest = useRef(props);
    const current = useRef(props.tabId);
    const createState = useRef<((text: string) => EditorState) | null>(null);
    const cache = useRef(new Map<string, EditorState>());
    const compartment = useRef(new Compartment());
    useLayoutEffect(() => {
      latest.current = props;
    });
    useImperativeHandle(
      ref,
      () => ({
        getSql: () => {
          const state = view.current?.state;
          if (!state) return "";
          const selected = state.selection.main;
          return selected.empty
            ? state.doc.toString()
            : state.sliceDoc(selected.from, selected.to);
        },
        focus: () => view.current?.focus(),
      }),
      [],
    );
    useEffect(() => {
      if (!host.current) return;
      const getState = (text: string) =>
        EditorState.create({
          doc: text,
          extensions: [
            basicSetup,
            compartment.current.of(
              language(latest.current.engine, latest.current.schema),
            ),
            syntaxHighlighting(highlighting),
            EditorView.contentAttributes.of({
              "aria-label": "SQL editor",
              spellcheck: "false",
            }),
            Prec.highest(
              keymap.of([
                {
                  key: "Mod-Enter",
                  run: (editor) => {
                    const selection = editor.state.selection.main;
                    latest.current.onRun(
                      selection.empty
                        ? editor.state.doc.toString()
                        : editor.state.sliceDoc(selection.from, selection.to),
                    );
                    return true;
                  },
                },
              ]),
            ),
            EditorView.updateListener.of((update) => {
              if (update.docChanged)
                latest.current.onChange(
                  current.current,
                  update.state.doc.toString(),
                );
            }),
          ],
        });
      const states = cache.current;
      createState.current = getState;
      const editor = new EditorView({
        state: getState(latest.current.code),
        parent: host.current,
      });
      view.current = editor;
      cache.current.set(latest.current.tabId, editor.state);
      return () => {
        editor.destroy();
        view.current = null;
        states.clear();
        createState.current = null;
      };
    }, []);
    useEffect(() => {
      const editor = view.current;
      if (!editor) return;
      const valid = new Set(props.tabIds.split("|"));
      if (current.current !== props.tabId) {
        if (valid.has(current.current))
          cache.current.set(current.current, editor.state);
        current.current = props.tabId;
        const saved = cache.current.get(props.tabId);
        if (saved) editor.setState(saved);
        else {
          const state = createState.current?.(props.code);
          if (state) editor.setState(state);
        }
        editor.focus();
      }
      // EditorState owns the live document. Parent snapshots must not overwrite newer keystrokes or selections.
      for (const id of cache.current.keys())
        if (!valid.has(id)) cache.current.delete(id);
    }, [props.tabId, props.code, props.tabIds, props.engine, props.schema]);
    useEffect(() => {
      view.current?.dispatch({
        effects: compartment.current.reconfigure(
          language(props.engine, props.schema),
        ),
      });
    }, [props.engine, props.schema, props.tabId]);
    return <div ref={host} className="sql-code-editor" />;
  },
);
