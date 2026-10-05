import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './tool-schema.js';

describe('zodToJsonSchema', () => {
  it('obje: zorunlu + optional alanlari ayirir', () => {
    const schema = z.object({ query: z.string(), limit: z.number().optional() });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    });
  });

  it('enum -> string + enum listesi', () => {
    const schema = z.object({ sinif: z.enum(['public', 'personal', 'secret']) });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { sinif: { type: 'string', enum: ['public', 'personal', 'secret'] } },
      required: ['sinif'],
    });
  });

  it('boolean, array ve aciklama tasinir', () => {
    const schema = z.object({
      arka_planda: z.boolean().describe('arka planda calistir'),
      etiketler: z.array(z.string()),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        arka_planda: { type: 'boolean', description: 'arka planda calistir' },
        etiketler: { type: 'array', items: { type: 'string' } },
      },
      required: ['arka_planda', 'etiketler'],
    });
  });

  it('default alan zorunlu degildir', () => {
    const schema = z.object({ n: z.number().default(5) });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { n: { type: 'number' } },
    });
  });

  it('bos obje', () => {
    expect(zodToJsonSchema(z.object({}))).toEqual({ type: 'object', properties: {} });
  });
});
