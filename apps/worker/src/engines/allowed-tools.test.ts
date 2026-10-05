import { describe, expect, it } from 'vitest';

import { buildClaudeAllowedToolsArgs } from './claude-code.js';
import { runCodex } from './codex.js';

describe('motor allowedTools sozlesmesi', () => {
  it('Claude Code allowlisti CLI bayragina tasir', () => {
    const flags = buildClaudeAllowedToolsArgs(['Read', 'Bash(git:*)']);

    expect(flags).toEqual(['--allowedTools', "'Read'", "'Bash(git:*)'"]);
  });

  it('Codex allowlist eslemesi yokken kosuyu baslatmadan fail-closed reddeder', async () => {
    const result = await runCodex({
      runId: 'allowed-tools-must-not-start',
      systemPrompt: 'system',
      prompt: 'task',
      cwd: '/tmp/repo',
      workRoots: ['C:\\repo'],
      allowedTools: ['Read'],
      model: null,
      host: 'wsl',
    });

    expect(result).toEqual({
      ok: false,
      text:
        'Codex motoru allowedTools allowlistini henuz uygulamiyor; ' +
        'arac siniri belirlenmeden kosu baslatilmadi: Read.',
      exitCode: null,
      timedOut: false,
      logPath: '',
    });
  });
});
