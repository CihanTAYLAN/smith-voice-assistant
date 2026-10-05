import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkspaceScope } from '@smith/tenancy';
import { createIrreversibleShellGuard, evaluateGuards, type ToolGuard } from './guard.js';
import { defineTool } from './tool.js';

const scope = createWorkspaceScope({
  workspaceId: 'ws_0123456789abcdefghij',
  actorId: 'act_0123456789abcdefghij',
  role: 'owner',
});

const shell = defineTool({
  name: 'run_powershell',
  description: 'Komut calistirir',
  parameters: z.object({ komut: z.string() }),
  execute: () => Promise.resolve(null),
});

function denyReason(command: string): string | undefined {
  const guard = createIrreversibleShellGuard();
  return guard({ tool: shell, input: { komut: command }, scope });
}

describe('evaluateGuards (monotonik)', () => {
  it('bos liste izin verir', () => {
    expect(evaluateGuards([], { tool: shell, input: {}, scope })).toBeUndefined();
  });

  it('ilk deny kazanir', () => {
    const a: ToolGuard = () => undefined;
    const b: ToolGuard = () => 'b reddetti';
    const c: ToolGuard = () => 'c reddetti';
    expect(evaluateGuards([a, b, c], { tool: shell, input: {}, scope })).toBe('b reddetti');
  });
});

describe('createIrreversibleShellGuard', () => {
  it('geri donusu olmayan komutlari reddeder', () => {
    expect(denyReason('Format-Volume -DriveLetter D')).toBeDefined();
    expect(denyReason('shutdown /s /t 0')).toBeDefined();
    expect(denyReason('diskpart')).toBeDefined();
    expect(denyReason('reg delete HKLM\\SOFTWARE\\x /f')).toBeDefined();
    expect(denyReason('rm -rf /')).toBeDefined();
    expect(denyReason('Set-MpPreference -DisableRealtimeMonitoring $true')).toBeDefined();
  });

  it('regresyon: -Format parametresi YANLIS POZITIF uretmez', () => {
    expect(denyReason("Get-Date -Format 'yyyy-MM-dd'")).toBeUndefined();
  });

  it('geri alinabilir isler serbest (dosya silme dahil)', () => {
    expect(denyReason('Remove-Item .\\gecici.txt')).toBeUndefined();
    expect(denyReason('Get-ChildItem')).toBeUndefined();
    expect(denyReason('echo merhaba')).toBeUndefined();
  });

  it('shell olmayan aracin girdisi taranmaz', () => {
    const guard = createIrreversibleShellGuard();
    const memory = defineTool({
      name: 'hafizada_ara',
      description: 'arar',
      parameters: z.object({ q: z.string() }),
      execute: () => Promise.resolve(null),
    });
    expect(guard({ tool: memory, input: { q: 'shutdown' }, scope })).toBeUndefined();
  });

  it('komut farkli anahtarlardan/duz string olarak da okunur', () => {
    const guard = createIrreversibleShellGuard();
    expect(guard({ tool: shell, input: { command: 'diskpart' }, scope })).toBeDefined();
    expect(guard({ tool: shell, input: 'diskpart', scope })).toBeDefined();
  });
});
