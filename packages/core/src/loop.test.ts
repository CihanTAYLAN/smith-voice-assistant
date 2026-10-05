import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWorkspaceScope } from '@smith/tenancy';
import { createIrreversibleShellGuard } from './guard.js';
import { runAgentTurn, toWireStopReason, type DeviceToolBridge } from './loop.js';
import { ToolRegistry, defineTool } from './tool.js';
import type { LoopMessage, LoopModel, LoopModelResult, ToolCall } from './types.js';

const scope = createWorkspaceScope({
  workspaceId: 'ws_0123456789abcdefghij',
  actorId: 'act_0123456789abcdefghij',
  role: 'owner',
});

const TC = 'tc_0123456789abcdefghij';

/** Onceden yazilmis adimlari sirayla donduren mock model. */
function scriptedModel(steps: readonly LoopModelResult[]): LoopModel {
  let index = 0;
  return {
    generate: () => {
      const next = steps[index];
      index += 1;
      return next ? Promise.resolve(next) : Promise.reject(new Error('model script tukendi'));
    },
  };
}

function userTurn(text: string): LoopMessage[] {
  return [{ role: 'user', content: text }];
}

function call(name: string, input: unknown, id = TC): ToolCall {
  return { toolCallId: id, name, input };
}

describe('runAgentTurn — durak matrisi', () => {
  it('arac yoksa end_turn', async () => {
    const model = scriptedModel([{ text: 'merhaba', toolCalls: [], stop: 'end_turn' }]);
    const result = await runAgentTurn({
      model,
      registry: new ToolRegistry(),
      scope,
      messages: userTurn('selam'),
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('merhaba');
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'merhaba' });
  });

  it('model max_tokens bildirirse tasinir', async () => {
    const model = scriptedModel([{ text: 'yarim', toolCalls: [], stop: 'max_tokens' }]);
    const result = await runAgentTurn({
      model,
      registry: new ToolRegistry(),
      scope,
      messages: userTurn('uzun'),
    });
    expect(result.stopReason).toBe('max_tokens');
  });

  it('arac cagrisi calisir, sonuc geri beslenir, sonra biter', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'echo',
        description: 'yankilar',
        parameters: z.object({ v: z.string() }),
        execute: (input) => Promise.resolve({ echoed: input.v }),
      }),
    );
    const model = scriptedModel([
      { text: '', toolCalls: [call('echo', { v: 'x' })], stop: 'tool_use' },
      { text: 'oldu', toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgentTurn({ model, registry, scope, messages: userTurn('echo x') });
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('oldu');
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ role: 'tool', ok: true, result: { echoed: 'x' } });
  });

  it('usage adimlar boyunca toplanir', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'noop',
        description: 'x',
        parameters: z.object({}),
        execute: () => Promise.resolve(null),
      }),
    );
    const model = scriptedModel([
      {
        text: '',
        toolCalls: [call('noop', {})],
        stop: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        text: 'bitti',
        toolCalls: [],
        stop: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 7 },
      },
    ]);
    const result = await runAgentTurn({ model, registry, scope, messages: userTurn('x') });
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 12 });
  });

  it('onceden iptal edilmis signal ile hic model cagrisi yapmadan cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const model: LoopModel = {
      generate: () => {
        called = true;
        return Promise.resolve<LoopModelResult>({ text: '', toolCalls: [], stop: 'end_turn' });
      },
    };
    const result = await runAgentTurn({
      model,
      registry: new ToolRegistry(),
      scope,
      messages: userTurn('x'),
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('cancelled');
    expect(called).toBe(false);
  });

  it('model firlatirsa error (sebep tasinir)', async () => {
    const boom = new Error('saglayici coktu');
    const model: LoopModel = { generate: () => Promise.reject(boom) };
    const result = await runAgentTurn({
      model,
      registry: new ToolRegistry(),
      scope,
      messages: userTurn('x'),
    });
    expect(result.stopReason).toBe('error');
    expect(result.error).toBe(boom);
  });

  it('surekli arac isteyen model maxSteps tavaninda durur', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'noop',
        description: 'x',
        parameters: z.object({}),
        execute: () => Promise.resolve(null),
      }),
    );
    const model: LoopModel = {
      generate: () =>
        Promise.resolve<LoopModelResult>({
          text: '',
          toolCalls: [call('noop', {})],
          stop: 'tool_use',
        }),
    };
    const result = await runAgentTurn({
      model,
      registry,
      scope,
      messages: userTurn('x'),
      maxSteps: 3,
    });
    expect(result.stopReason).toBe('max_steps');
  });

  it('son adimdaki arac sonucunu modele veremeyecekse yan etkiyi baslatmaz', async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register(
      defineTool({
        name: 'yan_etki',
        description: 'yan etki',
        parameters: z.object({}),
        execute: () => {
          executions += 1;
          return Promise.resolve(null);
        },
      }),
    );
    const model = scriptedModel([
      { text: '', toolCalls: [call('yan_etki', {})], stop: 'tool_use' },
    ]);
    const result = await runAgentTurn({
      model,
      registry,
      scope,
      messages: userTurn('x'),
      maxSteps: 1,
    });
    expect(result.stopReason).toBe('max_steps');
    expect(executions).toBe(0);
    expect(toWireStopReason(result.stopReason)).toBe('error');
  });

  it('iptal iki arac arasinda gelirse sonraki araci calistirmaz', async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry();
    const executions: string[] = [];
    registry.register(
      defineTool({
        name: 'ilk',
        description: 'ilk',
        parameters: z.object({}),
        execute: () => {
          executions.push('ilk');
          controller.abort();
          return Promise.resolve(null);
        },
      }),
    );
    registry.register(
      defineTool({
        name: 'ikinci',
        description: 'ikinci',
        parameters: z.object({}),
        execute: () => {
          executions.push('ikinci');
          return Promise.resolve(null);
        },
      }),
    );
    const result = await runAgentTurn({
      model: scriptedModel([
        {
          text: '',
          toolCalls: [call('ilk', {}, 'tc_1'), call('ikinci', {}, 'tc_2')],
          stop: 'tool_use',
        },
      ]),
      registry,
      scope,
      messages: userTurn('x'),
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('cancelled');
    expect(executions).toEqual(['ilk']);
  });

  it('tur iptal edilince calisan arac iptal sinyalini gorur (uzak istek surmez)', async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry();
    let toolSignal: AbortSignal | undefined;
    registry.register(
      defineTool({
        name: 'uzak',
        description: 'uzak istek',
        parameters: z.object({}),
        execute: (_input, ctx) => {
          toolSignal = ctx.signal;
          controller.abort();
          return Promise.resolve(null);
        },
      }),
    );
    const result = await runAgentTurn({
      model: scriptedModel([
        { text: '', toolCalls: [call('uzak', {})], stop: 'tool_use' },
        { text: 'devam', toolCalls: [], stop: 'end_turn' },
      ]),
      registry,
      scope,
      messages: userTurn('x'),
      signal: controller.signal,
    });
    expect(toolSignal?.aborted).toBe(true);
    expect(result.stopReason).toBe('cancelled');
  });

  it('zaman asimina uymayan araci beklemeyi birakir ve sinyali iletir', async () => {
    vi.useFakeTimers();
    try {
      const registry = new ToolRegistry();
      let receivedSignal: AbortSignal | undefined;
      registry.register(
        defineTool({
          name: 'asili',
          description: 'asili',
          parameters: z.object({}),
          execute: (_input, ctx) => {
            receivedSignal = ctx.signal;
            return new Promise(() => undefined);
          },
        }),
      );
      const turn = runAgentTurn({
        model: scriptedModel([
          { text: '', toolCalls: [call('asili', {})], stop: 'tool_use' },
          { text: 'devam', toolCalls: [], stop: 'end_turn' },
        ]),
        registry,
        scope,
        messages: userTurn('x'),
        toolTimeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(101);
      const result = await turn;
      expect(receivedSignal?.aborted).toBe(true);
      expect(result.stopReason).toBe('end_turn');
      expect(result.messages).toContainEqual(
        expect.objectContaining({ role: 'tool', ok: false, result: { error: 'tool_timeout' } }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runAgentTurn — arac sonuc yollari', () => {
  it('bilinmeyen arac ok:false doner ve dongu devam eder', async () => {
    const model = scriptedModel([
      { text: '', toolCalls: [call('yok', {})], stop: 'tool_use' },
      { text: 'devam', toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgentTurn({
      model,
      registry: new ToolRegistry(),
      scope,
      messages: userTurn('x'),
    });
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ ok: false, result: { error: 'unknown_tool' } });
  });

  it('gecersiz girdi ok:false doner', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'echo',
        description: 'x',
        parameters: z.object({ v: z.string() }),
        execute: (input) => Promise.resolve(input.v),
      }),
    );
    const model = scriptedModel([
      { text: '', toolCalls: [call('echo', { v: 123 })], stop: 'tool_use' },
      { text: 'son', toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgentTurn({ model, registry, scope, messages: userTurn('x') });
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ ok: false, result: { error: 'invalid_input' } });
  });

  it('guard reddi araci calistirmadan ok:false uretir', async () => {
    const registry = new ToolRegistry();
    let ran = false;
    registry.register(
      defineTool({
        name: 'run_powershell',
        description: 'x',
        parameters: z.object({ komut: z.string() }),
        execute: () => {
          ran = true;
          return Promise.resolve(null);
        },
      }),
    );
    const model = scriptedModel([
      { text: '', toolCalls: [call('run_powershell', { komut: 'shutdown /s' })], stop: 'tool_use' },
      { text: 'son', toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgentTurn({
      model,
      registry,
      scope,
      messages: userTurn('kapat'),
      guards: [createIrreversibleShellGuard()],
    });
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ ok: false });
    expect(ran).toBe(false);
  });

  it('device araci kopru ile calisir', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'cihaz_konum',
        description: 'konum',
        parameters: z.object({}),
        locus: 'device',
      }),
    );
    const bridge: DeviceToolBridge = (c) =>
      Promise.resolve({ toolCallId: c.toolCallId, ok: true, result: { lat: 41 } });
    const model = scriptedModel([
      { text: '', toolCalls: [call('cihaz_konum', {})], stop: 'tool_use' },
      { text: 'buldum', toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgentTurn({
      model,
      registry,
      scope,
      messages: userTurn('neredeyim'),
      deviceBridge: bridge,
    });
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ ok: true, result: { lat: 41 } });
  });

  it('device araci ama kopru yoksa ok:false', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'cihaz_konum',
        description: 'konum',
        parameters: z.object({}),
        locus: 'device',
      }),
    );
    const model = scriptedModel([
      { text: '', toolCalls: [call('cihaz_konum', {})], stop: 'tool_use' },
      { text: 'yok', toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgentTurn({ model, registry, scope, messages: userTurn('x') });
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ ok: false, result: { error: 'no_device_bridge' } });
  });
});

describe('ADR 0008 — opaque-block invariant (core sinirinda)', () => {
  it('loop gecmisi hicbir yerde thinking/reasoning tasimaz', async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: 'noop',
        description: 'x',
        parameters: z.object({}),
        execute: () => Promise.resolve({ ok: 1 }),
      }),
    );
    const model = scriptedModel([
      { text: 'dusunuyorum', toolCalls: [call('noop', {})], stop: 'tool_use' },
      { text: 'cevap', toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgentTurn({ model, registry, scope, messages: userTurn('x') });
    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toMatch(/thinking|redacted_thinking|reasoning/i);
  });
});

describe('toWireStopReason', () => {
  it('max_steps protokolde basari gibi sunulmaz', () => {
    expect(toWireStopReason('max_steps')).toBe('error');
  });

  it('digerleri birebir tasinir', () => {
    expect(toWireStopReason('end_turn')).toBe('end_turn');
    expect(toWireStopReason('max_tokens')).toBe('max_tokens');
    expect(toWireStopReason('cancelled')).toBe('cancelled');
    expect(toWireStopReason('error')).toBe('error');
  });
});
