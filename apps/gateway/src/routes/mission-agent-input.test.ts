import { describe, expect, it } from 'vitest';

import { allowedToolSchema, isSafeWorkRoot, workRootSchema } from './mission-agent-input.js';

describe('allowedToolSchema', () => {
  it.each([
    'Read',
    'Write',
    'Bash',
    'Bash(git:*)',
    'Bash(npm run test:*)',
    'Bash(git commit -m:*)',
    'WebFetch(domain:docs.example.com)',
    'mcp__server__tool',
    'Edit(/src/**)',
  ])('%s kabul edilir', (tool) => {
    expect(allowedToolSchema.safeParse(tool).success).toBe(true);
  });

  it.each([
    ['--dangerously-skip-permissions', 'bayrak (claude argv a bagimsiz bayrak olarak girer)'],
    ['-x', 'tire ile baslar'],
    [' Bash', 'bosluk ile baslar'],
    ['1Bash', 'rakamla baslar'],
    ['Bash;rm -rf /', 'kabuk ayiraci'],
    ['Bash\nRead', 'satir sonu'],
    ['Bash"', 'tirnak'],
    ['Bash$(id)', 'komut yerine koyma'],
    ['', 'bos'],
    [`R${'a'.repeat(200)}`, 'cok uzun'],
  ])('%j reddedilir (%s)', (tool) => {
    expect(allowedToolSchema.safeParse(tool).success).toBe(false);
  });
});

describe('isSafeWorkRoot', () => {
  it.each([
    '/home/alice/workspace/proje',
    '/tmp/a.b',
    '/mnt/c/Users/x',
    '/mnt/c/Users/x/',
    'C:\\Users\\alice\\proje',
    'c:/Users/x/proje',
    'D:\\work',
    '/home/x/./y',
  ])('%s kabul edilir', (root) => {
    expect(isSafeWorkRoot(root)).toBe(true);
  });

  it.each([
    ['relative/path', 'goreli yol'],
    ['src', 'goreli yol'],
    ['~/proje', 'ev dizini kisaltmasi'],
    ['-x', 'bayrak gibi'],
    ['--add-dir', 'bayrak gibi'],
    ['../x', '.. ile baslar'],
    ['/home/../etc', '.. icerir'],
    ['/home/x/..', 'sonda ..'],
    ['C:\\Users\\..\\Windows', 'Windows .. segmenti'],
    ['C:/a/../b', 'Windows .. segmenti (/)'],
    ['C:\\', 'surucu koku'],
    ['C:/', 'surucu koku (/)'],
    ['C:', 'surucu koku (iki nokta)'],
    ['C:foo', 'surucuye goreli'],
    ['/', 'dosya sistemi koku'],
    ['//', 'dosya sistemi koku (cift)'],
    ['/mnt/c', 'WSL surucu koku'],
    ['/mnt/c/', 'WSL surucu koku (/)'],
    ['/mnt/D', 'WSL surucu koku (buyuk harf)'],
    ['\\\\sunucu\\paylasim', 'UNC'],
    ['//sunucu/paylasim', 'UNC (/)'],
    ['\\\\?\\C:\\x', 'UNC uzun yol'],
    ['/home/x\u0000y', 'NUL'],
    ['/home/x\ny', 'satir sonu'],
  ])('%j reddedilir (%s)', (root) => {
    expect(isSafeWorkRoot(root)).toBe(false);
  });

  it('semada uzunluk siniri vardir', () => {
    expect(workRootSchema.safeParse(`/${'a'.repeat(399)}`).success).toBe(true);
    expect(workRootSchema.safeParse(`/${'a'.repeat(400)}`).success).toBe(false);
  });
});
