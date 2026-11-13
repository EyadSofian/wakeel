import { CODE_BODY_IGNORED_DIAGNOSTICS, TYPINGS_FILE_NAME } from "@wakeel/contracts";
import type { editor, IDisposable } from "monaco-editor";
import { useEffect, useRef } from "react";
import type { Monaco } from "./monaco-loader";
import { isDark, readThemeTokens, THEME_NAME, themeData } from "./monaco-theme";

/**
 * The Monaco editor for one piece of code (design system §4 CodeEditor). JavaScript, always LTR,
 * in the mono face at `text-code-body`, with the bot's generated typings loaded as an extra lib so
 * autocomplete and hover know every variable and its type. The text is the editor's own while it
 * has focus; `onCommit` receives it on blur and on unmount, so one editing session is one undo step.
 */
export function CodeEditor({
  monaco,
  modelId,
  value,
  typings,
  label,
  onCommit,
  onRun,
  onEscape,
}: {
  monaco: Monaco;
  /** Stable per code field (the card id): one model, so undo inside the editor survives re-renders. */
  modelId: string;
  value: string;
  typings: string;
  /** Accessible name of the text area. */
  label: string;
  onCommit: (source: string) => void;
  /** `⌘Enter`. Without it the shortcut is taken anyway, so it never inserts a line. */
  onRun?: () => void;
  /** `Esc` when the editor has nothing of its own to close (suggestions, hints, find, snippets). */
  onEscape?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const run = useRef(onRun);
  run.current = onRun;
  const esc = useRef(onEscape);
  esc.current = onEscape;
  const committed = useRef(value);

  useTypings(monaco, typings);
  useTheme(monaco);

  // Create the editor once per model; the parent keys this component by card.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value seeds the model only; later values arrive through setValue below.
  useEffect(() => {
    if (!host.current) return;
    const uri = monaco.Uri.parse(`file:///code/${modelId}.js`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, "javascript", uri);
    if (model.getValue() !== value) model.setValue(value);
    const css = getComputedStyle(document.documentElement);
    const px = (variable: string) => Number.parseFloat(css.getPropertyValue(variable)) || undefined;
    const inset = px("--space-5") ?? 0;
    const ed = monaco.editor.create(host.current, {
      model,
      theme: THEME_NAME,
      ariaLabel: label,
      automaticLayout: true,
      // The hidden textarea, not Chromium's EditContext: with EditContext, typed spaces were lost
      // in our end-to-end run, and the textarea path is the one IME input (Arabic) is proven on.
      editContext: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: css.getPropertyValue("--font-mono").trim(),
      // §2.2 code-body: 13 / 20.
      ...(px("--text-code-body") ? { fontSize: px("--text-code-body") } : {}),
      ...(px("--text-code-body--line-height") ? { lineHeight: px("--text-code-body--line-height") } : {}),
      tabSize: 2,
      renderLineHighlight: "line",
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      fixedOverflowWidgets: true,
      suggest: { showInlineDetails: true, preview: true },
      padding: { top: inset, bottom: inset },
    });
    editorRef.current = ed;
    const save = () => {
      const next = model.getValue();
      if (next === committed.current) return;
      committed.current = next;
      commit.current(next);
    };
    const blur = ed.onDidBlurEditorText(save);
    // Monaco takes Esc itself, so the drawer's own handler never sees it; leave it to Monaco only
    // while one of its widgets or modes is open.
    ed.addCommand(
      monaco.KeyCode.Escape,
      () => esc.current?.(),
      "!suggestWidgetVisible && !parameterHintsVisible && !findWidgetVisible && !inSnippetMode && !editorHasMultipleSelections && !renameInputVisible",
    );
    const runAction = ed.addAction({
      id: "studio.run-code",
      label: "Run code",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => run.current?.(),
    });
    // Fonts may arrive after the editor measured them; re-measure once they are ready.
    void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
    ed.focus();
    return () => {
      save();
      blur.dispose();
      runAction.dispose();
      ed.dispose();
      model.dispose();
      editorRef.current = null;
    };
  }, [monaco, modelId]);

  // A change from outside (undo on the canvas, another tab) replaces the text unless it is ours.
  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model || value === committed.current) return;
    committed.current = value;
    if (model.getValue() !== value) model.setValue(value);
  }, [value]);

  return <div ref={host} dir="ltr" className="h-full min-h-0 w-full" data-code-editor />;
}

/** The generated `.d.ts` as the JavaScript service's only extra lib, with the sandbox's settings. */
function useTypings(monaco: Monaco, typings: string) {
  useEffect(() => {
    const js = monaco.typescript.javascriptDefaults;
    js.setCompilerOptions({
      target: monaco.typescript.ScriptTarget.ESNext,
      lib: ["es2022"],
      allowJs: true,
      checkJs: true,
      strict: true,
      allowNonTsExtensions: true,
      noEmit: true,
    });
    js.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [...CODE_BODY_IGNORED_DIAGNOSTICS],
    });
    const lib: IDisposable = js.addExtraLib(typings, TYPINGS_FILE_NAME);
    return () => lib.dispose();
  }, [monaco, typings]);
}

/** The token theme, redefined when the page switches between light and dark. */
function useTheme(monaco: Monaco) {
  useEffect(() => {
    const apply = () => {
      monaco.editor.defineTheme(THEME_NAME, themeData(readThemeTokens(), isDark()));
      monaco.editor.setTheme(THEME_NAME);
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    const pinned = new MutationObserver(apply);
    pinned.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", apply);
      pinned.disconnect();
    };
  }, [monaco]);
}
