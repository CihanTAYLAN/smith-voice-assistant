import { useEffect, useRef, useState } from 'react';
import { Badge, Button, ScrollArea, Text, TextInput } from '@mantine/core';

import { fsRead, fsWrite, type FsEntryList } from './api.js';
import { FileEditor } from './FileEditor.js';
import { FileTree, useFileTree, type FileTreeModel } from './FileTree.js';
import { Empty, Fault, Loading } from './LoadView.js';
import { dataOf, useGate } from './loadable.js';
import type { DiscardGuard } from './useLeaveGuard.js';

/**
 * DOSYALAR — file manager (gez) + goruntule + DUZENLE.
 *
 * Sinirlar Rust'ta (`dashboard.rs`): yol izinli koklerin altinda olmali,
 * okuma 512 KB / yazma 512 KB, `.git` icine yazma YOK, kaydetme "beklenen
 * mtime" ile catisma kontrolunden gecer (diskte degisen dosyanin ustune
 * yazmak sessiz veri kaybidir — onlenir).
 *
 * DIZIN SINIRI: liste 3000 girisle sinirlidir; kesilen klasor icin
 * `TruncationNotice` tek satirlik uyari gosterir.
 *
 * KAYDEDILMEMIS ICERIK: kirli durum kabuga (`guard`) bildirilir; baska dosya
 * acmak, "Paneli kapat" ve yerel kapatma AYNI onaydan gecer (bkz. leaveGuard.ts).
 * Kapatma korumasi kurulamadiysa editor salt okunurdur.
 *
 * YARIS: son-secim-kazanir (yavas donen eski dosya yenisinin ustune yazmaz);
 * kaydetme tek-ucus (Ctrl+S dahil); okuma surerken editor kilitlidir.
 *
 * TARAYICI MODU: Rust koprusu yoksa hata bandi gorunur; panel cokmez.
 */

interface Props {
  /** Grafikten gelen "su dosyayi ac" istegi; tuketilince haber verilir. */
  pendingPath: string | null;
  onPendingConsumed: () => void;
  guard: DiscardGuard;
}

/** Editorun olustugu belge: yalniz bir dosya yuklenince degisir (key olur). */
interface LoadedFile {
  path: string;
  revision: number;
  initialText: string;
}

type Activity = 'idle' | 'reading' | 'saving';

interface Failure {
  message: string;
  conflict: boolean;
}

/** Bir yolun son parcasi (klasor adi); kok yollarinda da calisir. */
const leafOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * Giris sinirini asan ACIK klasorler icin TEK satirlik uyari; kesilen klasor yoksa
 * hicbir sey cizmez. Eksik listeyi tam sanmak sessiz bir yanlistir: aranan dosya
 * "yok" sanilabilir. Kesilme bilgisi listenin kendisinde tasinir (`FsEntryList`),
 * dosya agaci onu degistirmeden saklar.
 */
export function TruncationNotice({
  listing,
  open,
}: {
  listing: FileTreeModel['listing'];
  open: ReadonlySet<string>;
}): React.JSX.Element | null {
  const cut = [...open].flatMap((path) => {
    const state = listing[path];
    const list: FsEntryList | undefined = state ? dataOf(state) : undefined;
    return list?.truncation ? [{ path, ...list.truncation }] : [];
  });
  const [first] = cut;
  if (!first) return null;
  return (
    <p role="status" className="db-hint">
      {cut.length === 1
        ? `${leafOf(first.path)} klasöründe ${first.total} giriş var; ilk ${first.limit} tanesi gösteriliyor.`
        : `${cut.length} klasörde giriş sayısı ${first.limit} sınırını aşıyor; her birinde yalnız ilk ${first.limit} giriş gösteriliyor.`}
    </p>
  );
}

export function Files({ pendingPath, onPendingConsumed, guard }: Props): React.JSX.Element {
  const tree = useFileTree();
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [activity, setActivityState] = useState<Activity>('idle');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [filter, setFilter] = useState('');
  const reads = useGate();
  /** Esit zamanli olaylar (Ctrl+S ust uste) icin durumun SENKRON kopyasi. */
  const busy = useRef<Activity>('idle');
  /** Diskteki son bilinen hal (yukleme/kaydetme) ve editordeki guncel metin. */
  const disk = useRef({ mtimeMs: 0, text: '' });
  const draft = useRef('');
  const { confirmDiscard, setDirty, dirty, guarded } = guard;

  const setActivity = (next: Activity): void => {
    busy.current = next;
    setActivityState(next);
  };

  const openFile = async (path: string): Promise<void> => {
    if (busy.current === 'saving') return;
    if (!(await confirmDiscard())) return;
    const ticket = reads.next();
    setActivity('reading');
    setFailure(null);
    const result = await fsRead(path);
    if (!reads.isCurrent(ticket)) return;
    setActivity('idle');
    if (!result.ok) {
      setFailure({ message: result.error, conflict: false });
      return;
    }
    disk.current = { mtimeMs: result.value.mtimeMs, text: result.value.content };
    draft.current = result.value.content;
    setFile((previous) => ({
      path,
      revision: (previous?.revision ?? 0) + 1,
      initialText: result.value.content,
    }));
    setDirty(false);
  };

  const save = async (): Promise<void> => {
    if (!file || !guarded || busy.current !== 'idle') return;
    const text = draft.current;
    if (text === disk.current.text) return;
    setActivity('saving');
    setFailure(null);
    const result = await fsWrite(file.path, text, disk.current.mtimeMs);
    setActivity('idle');
    if (!result.ok) {
      setFailure({ message: result.error, conflict: result.code === 'conflict' });
      return;
    }
    disk.current = { mtimeMs: result.value.mtimeMs, text };
    // Kaydetme sirasinda yazilan karakterler diskte yok: kirli kalir.
    setDirty(draft.current !== text);
  };

  const edit = (text: string): void => {
    draft.current = text;
    setDirty(text !== disk.current.text);
  };

  // Grafikten gelen istek: ust dizinleri acar, dosyayi acar, sonra istegi tuketir.
  const latest = useRef({ reveal: tree.reveal, openFile, onPendingConsumed });
  useEffect(() => {
    latest.current = { reveal: tree.reveal, openFile, onPendingConsumed };
  });
  const rootsReady = dataOf(tree.roots) !== undefined;
  useEffect(() => {
    if (!pendingPath || !rootsReady) return;
    let cancelled = false;
    void (async () => {
      await latest.current.reveal(pendingPath);
      if (cancelled) return;
      await latest.current.openFile(pendingPath);
      if (!cancelled) latest.current.onPendingConsumed();
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingPath, rootsReady]);

  useEffect(() => reads.cancel, [reads]);

  const reading = activity === 'reading';

  return (
    <div className="fs">
      <div className="fs-left">
        <div className="fs-left-head">
          <h2>Çalışma alanı</h2>
          <TextInput
            size="sm"
            placeholder="Dosyalarda filtrele…"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            aria-label="Dosya filtresi"
          />
        </div>
        <TruncationNotice listing={tree.listing} open={tree.open} />
        <ScrollArea className="fs-tree" type="auto">
          <FileTree
            model={tree}
            filter={filter}
            selectedPath={file?.path ?? null}
            onOpenFile={(path) => void openFile(path)}
          />
        </ScrollArea>
      </div>

      <div className="fs-right">
        <div className="fs-toolbar">
          <div className="fs-document">
            <h2>{file ? leafOf(file.path) : 'Dosya düzenleyici'}</h2>
            <Text size="xs" c="dimmed" className="fs-path" title={file?.path ?? ''}>
              {file ? file.path : 'Soldan bir dosya seç'}
            </Text>
          </div>
          {dirty ? (
            <Badge color="yellow" variant="light" size="md">
              değişti
            </Badge>
          ) : null}
          <Button
            size="md"
            variant="light"
            disabled={!file || !guarded || !dirty || activity !== 'idle'}
            onClick={() => void save()}
          >
            kaydet (Ctrl+S)
          </Button>
          <Button
            size="sm"
            variant="subtle"
            disabled={!file || activity === 'saving'}
            onClick={() => {
              if (file) void openFile(file.path);
            }}
          >
            yeniden yükle
          </Button>
        </div>

        {failure ? (
          <Fault
            message={failure.message}
            {...(failure.conflict && file
              ? { onRetry: () => void openFile(file.path), retryLabel: 'diskteki hâli yükle' }
              : {})}
          />
        ) : null}
        {!guarded ? (
          <p className="db-hint">
            Düzenleme kapalı: bu pencerede kapatma koruması kurulamadı, kaydedilmemiş değişiklikler
            kaybolabilirdi. Dosyalar salt okunur açılır.
          </p>
        ) : null}
        {reading ? <Loading text="Dosya yükleniyor…" /> : null}
        {activity === 'saving' ? (
          <p role="status" className="db-hint">
            Kaydediliyor…
          </p>
        ) : null}

        {file ? (
          <FileEditor
            key={`${file.revision}-${guarded}`}
            initialText={file.initialText}
            editable={guarded}
            locked={reading}
            onChange={edit}
            onSave={() => void save()}
          />
        ) : (
          <Empty title="Bir dosya aç">Soldan bir dosya seç; Ctrl+S ile kaydet.</Empty>
        )}
      </div>
    </div>
  );
}
