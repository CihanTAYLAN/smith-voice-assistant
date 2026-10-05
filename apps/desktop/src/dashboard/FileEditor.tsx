import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';

interface FileEditorProps {
  /**
   * Acilan dosyanin metni. Editor bu degeri YALNIZ olusurken okur; sonraki
   * duzenlemeler editorde yasar. Yeni dosya/yeniden yukleme/duzenlenebilirlik
   * degisimi icin cagiran `key` degistirip ornegi yeniler.
   */
  initialText: string;
  editable: boolean;
  /** Okuma suruyor: yazim ve odak kapali (eski dosyaya yazilmasin). */
  locked: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
}

/** CodeMirror 6 (markdown + tek koyu tema). Ctrl/Cmd+S kaydeder; DOM'dan dinlenir. */
export function FileEditor({
  initialText,
  editable,
  locked,
  onChange,
  onSave,
}: FileEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      doc: initialText,
      extensions: [
        EditorView.editable.of(editable),
        EditorView.contentAttributes.of({ 'aria-label': 'Dosya düzenleyici' }),
        basicSetup,
        EditorView.lineWrapping,
        markdown(),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changeRef.current(update.state.doc.toString());
        }),
      ],
    });
    return () => view.destroy();
  }, [initialText, editable]);

  return (
    <div
      className="fs-editor"
      ref={hostRef}
      inert={locked}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          onSave();
        }
      }}
    />
  );
}
