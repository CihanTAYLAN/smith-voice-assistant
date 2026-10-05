import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, defineTool } from './tool.js';

describe('defineTool', () => {
  it('server araci execute olmadan tanimlanamaz', () => {
    expect(() => defineTool({ name: 'x', description: 'x', parameters: z.object({}) })).toThrow(
      /execute/,
    );
  });

  it('device araci execute olmadan tanimlanabilir', () => {
    const tool = defineTool({
      name: 'cihaz_konum',
      description: 'Cihazin konumu',
      parameters: z.object({}),
      locus: 'device',
    });
    expect(tool.locus).toBe('device');
    expect(tool.execute).toBeUndefined();
  });

  it('varsayilan locus server', () => {
    const tool = defineTool({
      name: 'echo',
      description: 'yankilar',
      parameters: z.object({ v: z.string() }),
      execute: (input) => Promise.resolve(input.v),
    });
    expect(tool.locus).toBe('server');
  });
});

describe('ToolRegistry', () => {
  const echo = defineTool({
    name: 'echo',
    description: 'yankilar',
    parameters: z.object({ v: z.string() }),
    execute: (input) => Promise.resolve(input.v),
  });

  it('ad cakismasi sessizce yutulmaz', () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    expect(() => registry.register(echo)).toThrow(/cakismasi/);
  });

  it('bilinmeyen arac undefined doner', () => {
    expect(new ToolRegistry().get('yok')).toBeUndefined();
  });

  it('specs modele ad + aciklama + sema verir', () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const specs = registry.specs();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe('echo');
    expect(specs[0]?.description).toBe('yankilar');
    expect(specs[0]?.parameters).toBe(echo.parameters);
  });
});
