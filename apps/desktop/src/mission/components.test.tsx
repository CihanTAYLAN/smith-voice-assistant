import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentPanel } from './AgentPanel.js';
import type { Agent, Task, TaskDetail } from './api.js';
import { Board } from './Board.js';
import { OrgChart } from './OrgChart.js';
import { TaskDrawer } from './TaskDrawer.js';

// Plazma yuzeyi WebGL ister; bu testler isaretlemeyi dener. Plazma ozelliklerini
// ayiklayip duz elemana indirir (deck.smoke.test.tsx plazmali yolu ayrica sinar).
vi.mock('@cruxgarden/plasma-ui', async () => {
  const { createElement } = await import('react');
  return {
    Plasma: ({ as = 'div', lean: _lean, radius: _radius, ...rest }: Record<string, unknown>) =>
      createElement(as as string, rest),
  };
});

const agent: Agent = {
  id: 'a1',
  slug: 'nova',
  displayName: 'Nova',
  role: 'araştırma',
  soul: 'Dikkatli ve kanıtlı çalış.',
  model: null,
  parentId: null,
  device: 'wsl',
  workRoots: ['/work'],
  allowedTools: ['Read'],
  status: 'working',
  lastSeenAt: null,
};

const task: Task = {
  id: 't1',
  title: 'Kanıtı hazırla',
  detail: null,
  status: 'inbox',
  priority: 2,
  assigneeId: 'a1',
  deliverable: null,
  artifactPath: null,
  createdBy: 'user',
  dueAt: null,
  startedAt: null,
  finishedAt: null,
  updatedAt: '2026-10-03T09:00:00Z',
};

const detail: TaskDetail = { task, comments: [], runs: [] };
const noop = (): void => undefined;
const done = (): Promise<null> => Promise.resolve(null);

/** Gorunen metin: etiketler atilir, boslugu normallestirilir. */
const visibleText = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** ASCII'ye katlanmis (diyakritiksiz) Turkce kelimeler kullaniciya cikmamali. */
const FOLDED_TURKISH =
  /\b(gorulme|yukleniyor|baglanti|basarisiz|Calisma|Cerceve|Yalniz|Hafiza|Gorev|secili|Atamasiz)\b/;

describe('Mission erisilebilir isaretleme', () => {
  it('gorev cekmecesini yerel dialog, kalici etiket ve bagli baslikla sunar', () => {
    const html = renderToStaticMarkup(
      <TaskDrawer
        detail={detail}
        agents={[agent]}
        transitions={{ inbox: ['assigned'] }}
        busy={false}
        status="ready"
        error={null}
        onClose={noop}
        onRetry={noop}
        onMove={done}
        onAssign={done}
        onComment={done}
      />,
    );
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-labelledby="task-drawer-title"');
    expect(html).toContain('id="task-drawer-title"');
    expect(html).toContain('Görev detayını kapat');
    for (const label of ['Ajan', 'Çalıştırma motoru', 'Yorum'])
      expect(html).toContain(`<span>${label}</span>`);
    expect(html).not.toContain('role="alert"');
    expect(visibleText(html)).not.toMatch(FOLDED_TURKISH);
  });

  it('ajan paneli yeni ajan formunu etiketler, ipuclari verir ve silme onayini ajan adiyla sunar', () => {
    const html = renderToStaticMarkup(
      <AgentPanel
        agents={[agent]}
        selected={agent}
        busy={false}
        active
        createOpen={false}
        onCreateOpenChange={noop}
        onCreate={done}
        onSaveSoul={done}
        onSetStatus={done}
        onDelete={done}
      />,
    );
    for (const label of [
      'Ajan kimliği',
      'Ajan adı',
      'Rol',
      'Cihaz',
      'Üst ajan',
      'Çalışma kökleri',
      'İzinli araçlar',
    ]) {
      expect(html).toContain(`<span>${label}</span>`);
    }
    expect(html.match(/<dialog/g)).toHaveLength(2);
    expect(html).toContain('Nova adlı ajanı sil');
    expect(html).toContain('aria-describedby="agent-slug-hint"');
    expect(html).toContain('En az 10 karakter.');
    expect(html).toContain('<option value="windows">windows</option>');
    expect(html).toContain('Çalışıyor');
    expect(visibleText(html)).not.toMatch(FOLDED_TURKISH);
  });

  it('ajan secili degilse kart yok, yeni ajan dugmesi her zaman var', () => {
    const html = renderToStaticMarkup(
      <AgentPanel
        agents={[]}
        selected={null}
        busy={false}
        active
        createOpen={false}
        onCreateOpenChange={noop}
        onCreate={done}
        onSaveSoul={done}
        onSetStatus={done}
        onDelete={done}
      />,
    );
    expect(html).not.toContain('agent-card');
    expect(html).toContain('+ Yeni ajan');
    expect(html).toContain('aria-haspopup="dialog"');
  });
});

describe('Mission yuzey durumlari', () => {
  const boardProps = {
    tasks: [task],
    agents: [agent],
    selectedTaskId: null,
    pendingTaskId: null,
    onSelectTask: noop,
  };

  it('ilk yukleme bos pano gibi gorunmez', () => {
    const html = renderToStaticMarkup(<Board {...boardProps} tasks={[]} status="loading" />);
    expect(html).toContain('Görevler yükleniyor');
    expect(html).not.toContain('col-empty');
    expect(html).not.toContain('class="board"');
  });

  it('hata durumunda kolonlar yerine uyari yazilir', () => {
    const html = renderToStaticMarkup(<Board {...boardProps} status="error" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Görev panosu yüklenemedi.');
  });

  it('gercek bos pano bos kolonlari "Gorev yok" ile gosterir', () => {
    const html = renderToStaticMarkup(<Board {...boardProps} tasks={[]} status="empty" />);
    expect(html.match(/Görev yok/g)).toHaveLength(6);
  });

  it('bayat pano son veriyi mesgul isaretiyle gosterir', () => {
    const html = renderToStaticMarkup(<Board {...boardProps} status="stale" />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Kanıtı hazırla');
  });

  it('kolon basliklari baslik elemani ve bolgeye baglidir; kart dialog acar', () => {
    const html = renderToStaticMarkup(<Board {...boardProps} status="ready" />);
    expect(html).toContain('<h3 class="col-name" id="col-inbox">Gelen</h3>');
    expect(html).toContain('aria-labelledby="col-inbox"');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it('detayi yuklenen kart mesgul isaretlenir, digerleri degil', () => {
    const second: Task = { ...task, id: 't2', title: 'Ikinci' };
    const html = renderToStaticMarkup(
      <Board
        {...boardProps}
        tasks={[task, second]}
        selectedTaskId="t1"
        pendingTaskId="t1"
        status="ready"
      />,
    );
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1);
  });

  it('ekip: yukleniyor, hata ve bos durumlar ayridir; bos ekip uygulama icinden eylem sunar', () => {
    const props = {
      agents: [],
      selectedId: null,
      loadByAgent: {},
      onSelect: noop,
      onCreateAgent: noop,
    };
    const loading = renderToStaticMarkup(<OrgChart {...props} status="loading" />);
    const failed = renderToStaticMarkup(<OrgChart {...props} status="error" />);
    const empty = renderToStaticMarkup(<OrgChart {...props} status="empty" />);
    expect(loading).toContain('Ekip yükleniyor');
    expect(failed).toContain('Ekip bilgisi yüklenemedi.');
    expect(empty).toContain('Yeni ajan');
    expect(empty).not.toContain('POST');
    expect(empty).not.toContain('curl');
  });
});

describe('Mission org semasi isaretlemesi', () => {
  const lead: Agent = {
    ...agent,
    id: 'a0',
    slug: 'smith',
    displayName: 'Smith',
    role: 'Yönetici',
    status: 'idle',
  };
  const child: Agent = { ...agent, parentId: 'a0', lastSeenAt: '2026-10-03T09:00:00Z' };
  const html = renderToStaticMarkup(
    <OrgChart
      agents={[lead, child]}
      selectedId="a1"
      loadByAgent={{ a1: 2 }}
      onSelect={noop}
      onCreateAgent={noop}
      status="ready"
    />,
  );

  it('her ajan acilip kapanan bir dugmedir; secili olan basili isaretlenir', () => {
    expect(html).not.toContain('role="tree"');
    expect(html.match(/role="button"/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(2);
  });

  it('erisilebilir ad ajan durumunu Turkce ve acik gorev sayisini verir', () => {
    expect(html).toContain('Nova, @nova, araştırma, wsl, Çalışıyor, 2 açık görev');
    expect(html).toContain('Smith, @smith, Yönetici, wsl, Boşta');
    expect(html).not.toContain('aria-label="Nova, @nova, araştırma, wsl, working');
  });

  it('ipucu dogru Turkce yazilir; zaman bilinmiyorsa bunu soyler', () => {
    expect(visibleText(html)).not.toMatch(FOLDED_TURKISH);
    // React 19: <title> dizi cocuk alirsa SSR'de bos yazilir; tek metin olmali.
    expect(html).toContain('<title>Smith · Boşta · son görülme bilinmiyor</title>');
  });

  it('uzun ad ve rol kutuya sigmaz diye kisaltilir, tam metin etikette kalir', () => {
    const long: Agent = {
      ...agent,
      slug: 'cok-uzun-bir-ajan-kimligi-denemesi',
      role: 'Çok uzun bir rol tanımı burada yazıyor',
    };
    const out = renderToStaticMarkup(
      <OrgChart
        agents={[long]}
        selectedId={null}
        loadByAgent={{}}
        onSelect={noop}
        onCreateAgent={noop}
        status="ready"
      />,
    );
    expect(out).toContain('@cok-uzun-bir-aj…');
    expect(out).toContain(
      'aria-label="Nova, @cok-uzun-bir-ajan-kimligi-denemesi, Çok uzun bir rol tanımı burada yazıyor',
    );
  });
});
