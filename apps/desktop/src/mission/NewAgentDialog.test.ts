import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import type { Agent, MissionResult } from './api.js';
import { NewAgentDialog, type NewAgentDialogProps } from './NewAgentDialog.js';
import { button, control, find, findAll, fire, mount, settle, textOf } from '../hookTestHost.js';

vi.mock('react', async (original) =>
  (await import('../hookTestHost.js')).reactWithHost(await original<typeof React>()),
);

const modal = vi.hoisted(() => ({
  calls: [] as Array<{ open: boolean; onClose: () => void }>,
}));
vi.mock('../useModalDialog.js', () => ({
  useModalDialog: (open: boolean, onClose: () => void) => {
    modal.calls.push({ open, onClose });
    return { current: null };
  },
}));

const LEAD: Agent = {
  id: 'a1',
  slug: 'smith',
  displayName: 'Smith',
  role: 'Yönetici',
  soul: 'Ekibi yönet.',
  model: null,
  parentId: null,
  device: 'wsl',
  workRoots: [],
  allowedTools: [],
  status: 'idle',
  lastSeenAt: null,
};

const done = (): Promise<MissionResult<null>> => Promise.resolve({ ok: true, value: null });
const refused = (error: string): Promise<MissionResult<null>> =>
  Promise.resolve({ ok: false, code: 'conflict', error });

function setup(overrides: Partial<NewAgentDialogProps> = {}) {
  const props: NewAgentDialogProps = {
    open: true,
    agents: [LEAD],
    busy: false,
    fallbackFocus: { current: null },
    onClose: vi.fn(),
    onCreate: vi.fn(done),
    ...overrides,
  };
  const view = mount(() => NewAgentDialog(props));
  let tree = view.render();
  view.flush();
  const rerender = (): void => {
    tree = view.render();
    view.flush();
  };
  return {
    props,
    get tree() {
      return tree;
    },
    rerender,
    type(label: string, value: string) {
      fire(control(tree, label), 'onChange', { target: { value } });
      rerender();
    },
    fillValid() {
      this.type('Ajan kimliği', 'nova');
      this.type('Ajan adı', '  Nova  ');
      this.type('Rol', 'Araştırma');
      this.type('Çalışma kökleri', '/a, /b ,');
      this.type('İzinli araçlar', 'Bash, Read');
      this.type('SOUL metni', '  Dikkatli ve kanıtlı çalış.  ');
      this.type('Üst ajan', 'smith');
    },
    submit() {
      fire(
        find(tree, (element) => element.type === 'form'),
        'onSubmit',
        { preventDefault: vi.fn() },
      );
    },
  };
}

const alerts = (tree: unknown): string[] =>
  findAll(tree, (element) => element.props.role === 'alert').map(textOf);

beforeEach(() => {
  modal.calls.length = 0;
});

describe('yeni ajan formu: dogrulama', () => {
  it('gecersiz kimlikle gonder kapali, alan gecersiz isaretli', () => {
    const dialog = setup();
    dialog.type('Ajan kimliği', '9nova');
    expect(control(dialog.tree, 'Ajan kimliği').props['aria-invalid']).toBe(true);
    expect(button(dialog.tree, 'Ekibe kat').props.disabled).toBe(true);
  });

  it('kimlik otomatik kucuk harfe cevrilir', () => {
    const dialog = setup();
    dialog.type('Ajan kimliği', 'NoVa');
    expect(control(dialog.tree, 'Ajan kimliği').props.value).toBe('nova');
  });

  it('tum zorunlu alanlar gecerliyken gonder acilir; mesgulken kapanir', () => {
    const dialog = setup();
    dialog.fillValid();
    expect(button(dialog.tree, 'Ekibe kat').props.disabled).toBe(false);

    const busy = setup({ busy: true });
    busy.fillValid();
    expect(button(busy.tree, 'Ekibe kat').props.disabled).toBe(true);
  });

  it('SOUL 10 karakterden kisaysa gonder kapali kalir', () => {
    const dialog = setup();
    dialog.fillValid();
    dialog.type('SOUL metni', 'kisa');
    expect(button(dialog.tree, 'Ekibe kat').props.disabled).toBe(true);
  });

  it('alan sinirlari sunucu semasiyla uyumludur', () => {
    const dialog = setup();
    expect(control(dialog.tree, 'Ajan kimliği').props.maxLength).toBe(32);
    expect(control(dialog.tree, 'Ajan adı').props.maxLength).toBe(64);
    expect(control(dialog.tree, 'Rol').props.maxLength).toBe(48);
  });

  it('wsl ve windows secilebilir, m2 ve server Faz 2 etiketli ve pasif', () => {
    const dialog = setup();
    const options = findAll(
      control(dialog.tree, 'Cihaz'),
      (element) => element.type === 'option',
    ).map((option) => [textOf(option), option.props.disabled === true]);
    expect(options).toEqual([
      ['wsl', false],
      ['windows', false],
      ['m2 (Faz 2)', true],
      ['server (Faz 2)', true],
    ]);
    expect(control(dialog.tree, 'Cihaz').props.value).toBe('wsl');
  });
});

describe('yeni ajan formu: gonderme', () => {
  it('kirpilmis metin ve ayrilmis listelerle olusturma istegi gonderir', async () => {
    const dialog = setup();
    dialog.fillValid();
    dialog.submit();
    await settle();
    expect(dialog.props.onCreate).toHaveBeenCalledWith({
      slug: 'nova',
      displayName: 'Nova',
      role: 'Araştırma',
      soul: 'Dikkatli ve kanıtlı çalış.',
      device: 'wsl',
      workRoots: ['/a', '/b'],
      allowedTools: ['Bash', 'Read'],
      parentSlug: 'smith',
    });
  });

  it('ust ajan secilmediyse parentSlug gonderilmez', async () => {
    const dialog = setup();
    dialog.fillValid();
    dialog.type('Üst ajan', '');
    dialog.submit();
    await settle();
    const [input] = (dialog.props.onCreate as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect('parentSlug' in input).toBe(false);
  });

  it('basarisizsa taslak ve pencere korunur, hata formun icinde gorunur', async () => {
    const dialog = setup({ onCreate: vi.fn(() => refused('Bu ajan kimliği zaten kullanımda.')) });
    dialog.fillValid();
    dialog.submit();
    await settle();
    dialog.rerender();

    expect(alerts(dialog.tree)).toEqual(['Bu ajan kimliği zaten kullanımda.']);
    expect(control(dialog.tree, 'Ajan kimliği').props.value).toBe('nova');
    expect(control(dialog.tree, 'SOUL metni').props.value).toBe('  Dikkatli ve kanıtlı çalış.  ');
    expect(dialog.props.onClose).not.toHaveBeenCalled();
  });

  it('basarili olunca taslak temizlenir ve pencere kapanir', async () => {
    const dialog = setup();
    dialog.fillValid();
    dialog.submit();
    await settle();
    dialog.rerender();

    expect(control(dialog.tree, 'Ajan kimliği').props.value).toBe('');
    expect(control(dialog.tree, 'SOUL metni').props.value).toBe('');
    expect(dialog.props.onClose).toHaveBeenCalledTimes(1);
  });

  it('gecersiz formda gonderme istek atmaz', async () => {
    const dialog = setup();
    dialog.submit();
    await settle();
    expect(dialog.props.onCreate).not.toHaveBeenCalled();
  });
});

describe('yeni ajan formu: kapatma', () => {
  it('Vazgec ve yerel kapanis taslagi SILMEZ ama hatayi temizler', async () => {
    const dialog = setup({ onCreate: vi.fn(() => refused('Hata.')) });
    dialog.fillValid();
    dialog.submit();
    await settle();
    dialog.rerender();
    expect(alerts(dialog.tree)).toHaveLength(1);

    fire(button(dialog.tree, 'Vazgeç'), 'onClick');
    dialog.rerender();
    expect(dialog.props.onClose).toHaveBeenCalledTimes(1);
    expect(alerts(dialog.tree)).toHaveLength(0);
    expect(control(dialog.tree, 'Ajan kimliği').props.value).toBe('nova');

    // Escape: tarayici dialog'u kapatir, `close` olayi hook uzerinden ayni yoldan gelir.
    modal.calls.at(-1)?.onClose();
    expect(dialog.props.onClose).toHaveBeenCalledTimes(2);
  });

  it('modal hook acik durumu ust bilesenden alir', () => {
    setup({ open: false });
    expect(modal.calls.at(-1)?.open).toBe(false);
    setup({ open: true });
    expect(modal.calls.at(-1)?.open).toBe(true);
  });

  it('dialog basliga baglidir ve kapat dugmesi erisilebilir ada sahiptir', () => {
    const dialog = setup();
    expect(find(dialog.tree, (element) => element.type === 'dialog').props['aria-labelledby']).toBe(
      'agent-form-title',
    );
    expect(
      find(dialog.tree, (element) => element.props['aria-label'] === 'Ajan formunu kapat'),
    ).toBeDefined();
  });
});
