import { useCallback, useRef, useState } from 'react';

import { fsList, fsRoots, type FsEntry, type FsRoot } from './api.js';
import { ancestorDirs } from './treePaths.js';
import { Fault, faultText, LoadView } from './LoadView.js';
import { dataOf, nextLoadState, useLoadable, type LoadState } from './loadable.js';

/**
 * DOSYA AGACI: kokler + tembel dizin listeleri.
 *
 * Her dizin kendi durumunu (`LoadState`) tasir: bir dizinin hatasi baska bir
 * dizinin basarisini silmez ve basarisiz dizin satirinin altinda "yeniden dene"
 * ile gorunur. Dizinler ilk acilista yuklenir (onceden degil); ayni dizine
 * eszamanli istek tek ucusa iner.
 */

const LOADING: LoadState<never> = { status: 'loading' };
const INDENT_PX = 14;

export interface FileTreeModel {
  roots: LoadState<FsRoot[]>;
  reloadRoots: () => void;
  listing: Record<string, LoadState<FsEntry[]>>;
  open: ReadonlySet<string>;
  toggle: (path: string) => void;
  retry: (path: string) => void;
  /** Dosyanin ust dizinlerini yukleyip acar (grafikten "Dosyalar'da aç"). */
  reveal: (filePath: string) => Promise<void>;
}

export function useFileTree(): FileTreeModel {
  const roots = useLoadable(fsRoots);
  const [listing, setListing] = useState<Record<string, LoadState<FsEntry[]>>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const flights = useRef(new Set<string>());

  const load = useCallback(async (path: string): Promise<void> => {
    if (flights.current.has(path)) return;
    flights.current.add(path);
    setListing((previous) =>
      previous[path]?.status === 'ready' ? previous : { ...previous, [path]: LOADING },
    );
    const result = await fsList(path);
    flights.current.delete(path);
    setListing((previous) => ({
      ...previous,
      [path]: nextLoadState(previous[path] ?? LOADING, result),
    }));
  }, []);

  const expand = useCallback((path: string): void => {
    setOpen((previous) => new Set(previous).add(path));
  }, []);

  const toggle = (path: string): void => {
    if (open.has(path)) {
      setOpen((previous) => {
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
      return;
    }
    expand(path);
    if (listing[path]?.status !== 'ready') void load(path);
  };

  const rootList = dataOf(roots.state);
  const reveal = async (filePath: string): Promise<void> => {
    for (const dir of ancestorDirs(rootList ?? [], filePath)) {
      await load(dir);
      expand(dir);
    }
  };

  return {
    roots: roots.state,
    reloadRoots: () => void roots.reload(true),
    listing,
    open,
    toggle,
    retry: (path) => void load(path),
    reveal,
  };
}

interface FileTreeProps {
  model: FileTreeModel;
  filter: string;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

export function FileTree({ model, ...rest }: FileTreeProps): React.JSX.Element {
  return (
    <LoadView state={model.roots} loadingText="Dosyalar yükleniyor…" onRetry={model.reloadRoots}>
      {(roots) =>
        roots.length === 0 ? (
          <p className="db-hint">Dosya kökü yok.</p>
        ) : (
          <Entries
            model={model}
            entries={roots.map((root): FsEntry => ({
              name: root.label,
              path: root.path,
              kind: 'dir',
              size: 0,
              mtimeMs: 0,
            }))}
            depth={0}
            {...rest}
          />
        )
      }
    </LoadView>
  );
}

interface BranchProps extends FileTreeProps {
  depth: number;
}

function Entries({
  entries,
  depth,
  ...context
}: BranchProps & { entries: FsEntry[] }): React.JSX.Element {
  const { model, filter, selectedPath, onOpenFile } = context;
  const needle = filter.trim().toLocaleLowerCase('tr');
  const visible = entries.filter(
    (entry) =>
      needle === '' || entry.kind === 'dir' || entry.name.toLocaleLowerCase('tr').includes(needle),
  );
  return (
    <>
      {visible.map((entry) => {
        const isDir = entry.kind === 'dir';
        const isOpen = isDir && model.open.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              className="fs-row"
              style={{ paddingLeft: `${8 + depth * INDENT_PX}px` }}
              data-active={selectedPath === entry.path}
              aria-expanded={isDir ? isOpen : undefined}
              title={entry.path}
              onClick={() => (isDir ? model.toggle(entry.path) : onOpenFile(entry.path))}
            >
              <span className="fs-glyph" aria-hidden="true">
                {isDir ? (isOpen ? '▾' : '▸') : '·'}
              </span>
              <span className="fs-name">{entry.name}</span>
            </button>
            {isOpen ? <Listing {...context} path={entry.path} depth={depth} /> : null}
          </div>
        );
      })}
    </>
  );
}

/** Acik bir dizinin altindaki durum: yukleniyor | hata (yeniden dene) | bos | icerik. */
function Listing({ path, depth, ...context }: BranchProps & { path: string }): React.JSX.Element {
  const { model } = context;
  const state = model.listing[path] ?? LOADING;
  const fault = faultText(state, 'Klasör');
  const indent = { marginLeft: `${8 + (depth + 1) * INDENT_PX}px` };
  return (
    <>
      {state.status === 'loading' ? (
        <p role="status" className="db-hint" style={indent}>
          Yükleniyor…
        </p>
      ) : null}
      {fault ? <Fault message={fault} onRetry={() => model.retry(path)} /> : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <p className="db-hint" style={indent}>
          Dizin boş.
        </p>
      ) : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <Entries {...context} entries={state.data} depth={depth + 1} />
      ) : null}
    </>
  );
}
