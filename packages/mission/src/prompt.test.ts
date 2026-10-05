import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_MARKER,
  buildAgentSystemPrompt,
  buildTaskPrompt,
  parseDeliverable,
} from './prompt.js';
import type { AgentRecord, TaskCommentRecord, TaskRecord } from './repo.js';

const agent: AgentRecord = {
  id: 'agt_00000000000000000000',
  workspaceId: 'ws_00000000000000000000',
  slug: 'nova',
  displayName: 'Nova',
  role: 'arastirma',
  soul: 'Kaynak gostermeden iddia etmem.',
  model: null,
  parentId: null,
  device: 'wsl',
  workRoots: ['/home/alice/workspace/smith'],
  allowedTools: [],
  status: 'idle',
  lastSeenAt: null,
  createdAt: new Date('2026-08-14T00:00:00Z'),
  updatedAt: new Date('2026-08-14T00:00:00Z'),
};

const task: TaskRecord = {
  id: 'tsk_00000000000000000000',
  workspaceId: 'ws_00000000000000000000',
  title: 'Rakip analizi cikar',
  detail: 'Mission Control benzeri urunleri karsilastir.',
  status: 'assigned',
  priority: 2,
  assigneeId: agent.id,
  parentId: null,
  deliverable: null,
  artifactPath: null,
  createdBy: 'smith',
  dueAt: new Date('2026-08-15T12:00:00Z'),
  startedAt: null,
  finishedAt: null,
  createdAt: new Date('2026-08-14T00:00:00Z'),
  updatedAt: new Date('2026-08-14T00:00:00Z'),
};

describe('sistem prompt', () => {
  it('SOUL metnini oldugu gibi tasir', () => {
    expect(buildAgentSystemPrompt(agent)).toContain('Kaynak gostermeden iddia etmem.');
  });

  it('calisma koklerini ve kimligi yazar', () => {
    const prompt = buildAgentSystemPrompt(agent);
    expect(prompt).toContain('@nova');
    expect(prompt).toContain('/home/alice/workspace/smith');
  });

  it('dosya isi olmayan ajanda kok listesi bos oldugunu soyler', () => {
    expect(buildAgentSystemPrompt({ ...agent, workRoots: [] })).toContain('yok (dosya isi yok)');
  });

  // parseDeliverable engeli YALNIZ son satirda, buyuk harfle ve nedenle arar:
  // prompt ajana tam bu bicimi tarif etmeli, yoksa gercek engel kacar.
  it('engel bicimini ayristiricinin bekledigi sekilde tarif eder', () => {
    const prompt = buildAgentSystemPrompt(agent);
    expect(prompt).toContain('"ENGEL: <neden>"');
    expect(prompt).toContain('raporun son satirina');
    expect(prompt).toContain('Engel yoksa bu satiri yazma');
  });
});

describe('gorev prompt', () => {
  it('baslik, ayrinti ve termini tasir', () => {
    const prompt = buildTaskPrompt({ task });
    expect(prompt).toContain('Rakip analizi cikar');
    expect(prompt).toContain('Mission Control benzeri');
    expect(prompt).toContain('2026-08-15');
  });

  it('panodaki tartismayi ekler ama onceki teslimi tekrar etmez', () => {
    const comments: TaskCommentRecord[] = [
      {
        id: 'tcm_00000000000000000001',
        taskId: task.id,
        authorType: 'user',
        authorId: 'act_00000000000000000000',
        agentId: null,
        kind: 'note',
        body: 'Fiyatlandirmaya da bak',
        mentions: [],
        createdAt: new Date('2026-08-14T01:00:00Z'),
      },
      {
        id: 'tcm_00000000000000000002',
        taskId: task.id,
        authorType: 'agent',
        authorId: agent.id,
        agentId: agent.id,
        kind: 'deliver',
        body: 'onceki teslim metni',
        mentions: [],
        createdAt: new Date('2026-08-14T02:00:00Z'),
      },
    ];
    const prompt = buildTaskPrompt({ task, comments });
    expect(prompt).toContain('Fiyatlandirmaya da bak');
    expect(prompt).not.toContain('onceki teslim metni');
  });

  it('yeniden atanan gorevde onceki teslim ozetini ekler', () => {
    const prompt = buildTaskPrompt({
      task: { ...task, deliverable: 'onceki teslim metni' },
    });

    expect(prompt).toContain('Onceki teslim (revizyon icin):');
    expect(prompt).toContain('onceki teslim metni');
  });

  it('yorumlarda en yeni kayitlari karakter butcesinde tutar', () => {
    const comments: TaskCommentRecord[] = Array.from({ length: 20 }, (_, index) => ({
      id: `tcm_${String(index).padStart(20, '0')}`,
      taskId: task.id,
      authorType: 'user',
      authorId: 'act_00000000000000000000',
      agentId: null,
      kind: 'note',
      body: `yorum-${index}-${'x'.repeat(120)}`,
      mentions: [],
      createdAt: new Date(2026, 7, 14, 0, index),
    }));

    const prompt = buildTaskPrompt({ task, comments, maxCommentChars: 500 });
    expect(prompt).toContain('yorum-19');
    expect(prompt).not.toContain('yorum-0-');
    expect(prompt.length).toBeLessThan(1_000);
    // Atlanan yorumlar sessizce kaybolmaz: ajan thread'in kesildigini bilir.
    expect(prompt).toMatch(/\(1[0-9] eski yorum prompt butcesi nedeniyle gosterilmiyor\)/);
    // Gorunen kisim eski → yeni sirasini korur.
    const shown = [...prompt.matchAll(/yorum-(\d+)-/g)].map((match) => Number(match[1]));
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(shown.at(-1)).toBe(19);
  });

  describe('en yeni yorum tek basina butceyi asarsa', () => {
    const note = (index: number, body: string): TaskCommentRecord => ({
      id: `tcm_${String(index).padStart(20, '0')}`,
      taskId: task.id,
      authorType: 'agent',
      authorId: agent.id,
      agentId: agent.id,
      kind: 'note',
      body,
      mentions: [],
      createdAt: new Date(2026, 7, 14, 0, index),
    });

    it('thread dusmez: yorum bas ve sonuyla kirpilir, eski yorumlar yine girer', () => {
      // Ajanin uzun ENGEL raporu: ne yapildigi basta, engelin nedeni sonda.
      const report = `basi-${'x'.repeat(17_000)}-ENGEL-nedeni`;
      const prompt = buildTaskPrompt({
        task,
        comments: [note(1, 'ilk talimat'), note(2, 'ikinci talimat'), note(3, report)],
      });

      expect(prompt).toContain('ilk talimat');
      expect(prompt).toContain('ikinci talimat');
      expect(prompt).toContain('basi-');
      expect(prompt).toContain('-ENGEL-nedeni');
      expect(prompt).toContain('[...kirpildi...]');
      expect(prompt).not.toContain('gosterilmiyor');
      expect(prompt.length).toBeLessThan(9_000);
    });

    it('butcenin yarisindan fazlasini almaz (eski yorumlara yer birakir)', () => {
      const prompt = buildTaskPrompt({
        task,
        comments: [note(1, 'eski-yorum'), note(2, 'y'.repeat(5_000))],
        maxCommentChars: 1_000,
      });

      expect(prompt).toContain('eski-yorum');
      expect(prompt.length).toBeLessThan(1_200);
    });

    it('butceye sigan yorum kirpilmaz', () => {
      const prompt = buildTaskPrompt({ task, comments: [note(1, 'z'.repeat(9_000))] });

      expect(prompt).toContain('z'.repeat(9_000));
      expect(prompt).not.toContain('kirpildi');
    });
  });

  it('butceye sigan thread kesilmez ve uyari satiri eklenmez', () => {
    const comments: TaskCommentRecord[] = [
      {
        id: 'tcm_00000000000000000001',
        taskId: task.id,
        authorType: 'user',
        authorId: 'act_00000000000000000000',
        agentId: null,
        kind: 'note',
        body: 'kisa not',
        mentions: [],
        createdAt: new Date(2026, 7, 14),
      },
    ];
    const prompt = buildTaskPrompt({ task, comments });
    expect(prompt).toContain('kisa not');
    expect(prompt).not.toContain('gosterilmiyor');
  });
});

describe('teslim ayristirma', () => {
  it('marker satirini rapordan cikarir ve yolu alir', () => {
    const parsed = parseDeliverable(
      `Analizi cikardim, 4 urun karsilastirildi.\n${ARTIFACT_MARKER} /tmp/analiz.md`,
    );
    expect(parsed.artifactPath).toBe('/tmp/analiz.md');
    expect(parsed.summary).toBe('Analizi cikardim, 4 urun karsilastirildi.');
    expect(parsed.blocked).toBe(false);
  });

  it('marker yoksa teslim yine gecerlidir', () => {
    const parsed = parseDeliverable('Dosya uretmedim, bulgular sunlar.');
    expect(parsed.artifactPath).toBeUndefined();
    expect(parsed.summary).toContain('bulgular');
  });

  it('ENGEL satirini gorur ve raporda tutar', () => {
    const parsed = parseDeliverable('ENGEL: gateway ayakta degil, testi kosamadim.');
    expect(parsed.blocked).toBe(true);
    expect(parsed.summary).toContain('gateway ayakta degil');
  });

  // Turkce rapor dogal olarak "Engel: yok" satiri icerir; basarili teslimi
  // "ajan engel bildirdi" diye blocked yapmamali.
  it.each([
    'Yapildi, testler gecti.\nEngel: yok',
    'Yapildi.\n  engel: yok (kalan is yok)',
    'Yapildi.\nENGEL: yok',
    'Yapildi.\nENGEL: Yok.',
    'Yapildi.\nENGEL: yok (kalan is yok)',
    'Yapildi.\nENGEL: none',
    'Yapildi.\nENGEL: -',
    'Yapildi.\nENGELLER: yok',
    'Yapildi.\n- Engel : yok',
    'Yapildi.\r\nENGEL: yok\r\n',
  ])('engel olmadigini soyleyen satir teslimi blocked yapmaz: %j', (text) => {
    expect(parseDeliverable(text).blocked).toBe(false);
  });

  it('buyuk harfli olmayan "Engel:" dogal metindir, isaret degildir', () => {
    expect(parseDeliverable('Yapildi.\nEngel: gateway yavasti ama cozuldu.').blocked).toBe(false);
  });

  it('ENGEL isareti yalniz SON bos olmayan satirdadir; rapor ortasindaki satir isaret degildir', () => {
    const middle = parseDeliverable('ENGEL: eski deneme takildi\nsonra cozdum, testler gecti.');
    expect(middle.blocked).toBe(false);

    const last = parseDeliverable('Kismen yapildi.\n\nENGEL: gateway ayakta degil\n\n  \n');
    expect(last.blocked).toBe(true);
    expect(last.summary).toContain('gateway ayakta degil');
  });

  it('TESLIM-DOSYA satiri ENGEL satirinin sonda olmasini bozmaz', () => {
    const parsed = parseDeliverable(
      `Yarim kaldi.\nENGEL: disk dolu\n${ARTIFACT_MARKER} /tmp/yarim.md`,
    );
    expect(parsed.blocked).toBe(true);
    expect(parsed.artifactPath).toBe('/tmp/yarim.md');
  });

  it('ENGEL: ile baslayan satir icerik tasiyorsa (yok/none/- degilse) blocked', () => {
    expect(parseDeliverable('ENGEL: yok degil, gateway kapali').blocked).toBe(true);
    expect(parseDeliverable('rapor\r\nENGEL: izin reddedildi\r\n').blocked).toBe(true);
  });

  it('birden fazla marker varsa sonuncusu kazanir', () => {
    const parsed = parseDeliverable(
      `ilk deneme\n${ARTIFACT_MARKER} /tmp/eski.md\ndogru dosya\n${ARTIFACT_MARKER} /tmp/yeni.md`,
    );
    expect(parsed.artifactPath).toBe('/tmp/yeni.md');
  });

  it('bos marker degeri yolu bozmaz', () => {
    const parsed = parseDeliverable(`rapor\n${ARTIFACT_MARKER}`);
    expect(parsed.artifactPath).toBeUndefined();
    expect(parsed.summary).toBe('rapor');
  });
});
