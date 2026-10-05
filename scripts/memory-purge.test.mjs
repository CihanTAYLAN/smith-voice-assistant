import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPurgePlan, executeMemoryPurge } from './memory-purge.mjs';

const memories = [
  {
    id: 'mem_jax',
    workspaceId: 'ws_1',
    sourceType: 'obsidian',
    sourceId: 'obsidian:acme/a.md',
    content: 'isveren notu',
    status: 'active',
    supersededById: null,
  },
  {
    id: 'mem_mix',
    workspaceId: 'ws_1',
    sourceType: 'consolidated',
    sourceId: 'consolidated:mix',
    content: 'ProjectX ve Acme karisik ozet',
    status: 'active',
    supersededById: null,
  },
  {
    id: 'mem_keep',
    workspaceId: 'ws_1',
    sourceType: 'note',
    sourceId: 'note:projectx',
    content: 'ProjectX karari',
    status: 'superseded',
    supersededById: 'mem_mix',
  },
  {
    id: 'mem_drop',
    workspaceId: 'ws_1',
    sourceType: 'code',
    sourceId: 'code:_workshop-smoke/WebApp',
    content: 'kod',
    status: 'superseded',
    supersededById: 'mem_mix',
  },
];

const gaps = [
  {
    id: 'gap_by_source',
    workspaceId: 'ws_1',
    question: 'Unvan ne?',
    sourceMemoryIds: ['mem_jax'],
  },
  {
    id: 'gap_by_question',
    workspaceId: 'ws_1',
    question: 'Acme icin ne yapildi?',
    sourceMemoryIds: ['mem_keep'],
  },
];

const rules = 'obsidian:acme/*,code:_workshop-smoke/*,kw:acme';

test('plan eslesen memory ve gapleri bulur, temiz superseded kaynagi geri acar', () => {
  const plan = buildPurgePlan(memories, gaps, rules);

  assert.deepEqual(plan.memoryIds, ['mem_drop', 'mem_jax', 'mem_mix']);
  assert.deepEqual(plan.gapIds, ['gap_by_question', 'gap_by_source']);
  assert.deepEqual(plan.reactivateIds, ['mem_keep']);
  assert.deepEqual(plan.sourceTypeCounts, { code: 1, consolidated: 1, obsidian: 1 });
  assert.deepEqual(plan.sampleSourceIds, [
    'code:_workshop-smoke/WebApp',
    'consolidated:mix',
    'obsidian:acme/a.md',
  ]);
});

function fakeClient({ failDelete = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT') && sql.includes('FROM "Memory"') && !sql.includes('MemoryGap'))
        return { rows: memories };
      if (sql.startsWith('SELECT') && sql.includes('FROM "MemoryGap"')) return { rows: gaps };
      if (failDelete && sql.startsWith('DELETE FROM "Memory"')) throw new Error('silme patladi');
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls };
}

test('kuru kosu yalniz sayim ve sourceId basar, icerik veya mutasyon SQLi yoktur', async () => {
  const { client, calls } = fakeClient();
  const lines = [];

  const plan = await executeMemoryPurge({
    client,
    apply: false,
    rawRules: rules,
    write: (s) => lines.push(s),
  });

  assert.equal(plan.memoryIds.length, 3);
  assert.ok(calls.some(({ sql }) => sql.startsWith('BEGIN')));
  assert.ok(calls.some(({ sql }) => sql === 'ROLLBACK'));
  assert.ok(!calls.some(({ sql }) => /UPDATE|DELETE/.test(sql)));
  const output = lines.join('\n');
  assert.match(output, /KURU KOSU/);
  assert.match(output, /obsidian:acme\/a\.md/);
  assert.doesNotMatch(output, /ProjectX ve Acme karisik ozet/);
  assert.doesNotMatch(output, /isveren notu/);
});

test('apply advisory lock, restore ve silmeleri tek transactionda yapar', async () => {
  const { client, calls } = fakeClient();

  await executeMemoryPurge({ client, apply: true, rawRules: rules, write: () => {} });

  const sql = calls.map((call) => call.sql);
  assert.ok(sql.some((text) => text.includes('pg_advisory_xact_lock')));
  assert.ok(sql.some((text) => text.startsWith('UPDATE "Memory"')));
  assert.ok(sql.some((text) => text.startsWith('DELETE FROM "MemoryGap"')));
  assert.ok(sql.some((text) => text.startsWith('DELETE FROM "Memory"')));
  assert.equal(sql.at(-1), 'COMMIT');
});

test('apply hatasinda rollback yapar', async () => {
  const { client, calls } = fakeClient({ failDelete: true });

  await assert.rejects(
    executeMemoryPurge({ client, apply: true, rawRules: rules, write: () => {} }),
    /silme patladi/,
  );

  assert.equal(calls.at(-1)?.sql, 'ROLLBACK');
});
