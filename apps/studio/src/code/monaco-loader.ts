/**
 * Loads Monaco on first use (ADR-011: lazy-loaded), with its editor and TypeScript workers bundled
 * by Vite. Nothing is fetched from a CDN. The promise is shared, so opening a second drawer reuses
 * the loaded editor; a failed load is forgotten, so "Try again" loads afresh.
 */
export type Monaco = typeof import("monaco-editor");

let loading: Promise<Monaco> | undefined;

export function loadMonaco(): Promise<Monaco> {
  loading ??= (async () => {
    const [{ default: EditorWorker }, { default: TsWorker }, monaco] = await Promise.all([
      import("monaco-editor/editor/editor.worker.js?worker"),
      import("monaco-editor/language/typescript/ts.worker.js?worker"),
      import("monaco-editor"),
    ]);
    self.MonacoEnvironment = {
      getWorker: (_id, label) =>
        label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker(),
    };
    return monaco;
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
