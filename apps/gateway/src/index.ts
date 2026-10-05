import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { randomBytes } from 'node:crypto';
import { AuthError, verifyAccessToken } from '@smith/auth';
import { createDb, createSession, findSession, registerDevice } from '@smith/db';
import { gatewayEnvSchema, loadEnv } from '@smith/env';
import { createLlmRouterFromEnv, describeChain } from '@smith/llm';
import { createEmbedderFromEnv } from '@smith/memory';
import { initTracing, observe } from '@smith/observability';
import { createQueue, createQueueConnection, QueueName } from '@smith/queue';
import {
  parseClientFrame,
  MAX_TRANSPORT_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  type ServerFrame,
} from '@smith/protocol';
import { withScope } from '@smith/db';
import { ForbiddenError, type WorkspaceScope } from '@smith/tenancy';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { createLlmLoopModel } from './agent/llm-loop-model.js';
import {
  createDeviceBridge,
  resolveDeviceResult,
  type PendingDeviceCalls,
} from './agent/device-bridge.js';
import { AgentTurnIncompleteError, runAgentChatTurn } from './agent/run-turn.js';
import { buildAgentRegistry } from './agent/tools.js';
import { isFlagOn } from './env-flags.js';
import { maskedErrorHandler } from './error-handler.js';
import { createHealthHandler } from './health.js';
import { formatListenUrl, isLoopbackAddress, resolveRemoteAddress } from './network.js';
import { guardUpgradeTarget, installUnhandledRejectionLogger } from './process-guards.js';
import {
  createAttemptLimiter,
  tooManyRequests,
  WS_TICKET_POLICY,
} from './routes/attempt-limiter.js';
import { createAuthRoutes } from './routes/auth.js';
import { createConversationRoutes, resolveIdleHours } from './routes/conversation.js';
import { createDevLoginRoutes } from './routes/dev-login.js';
import { createMissionRoutes } from './routes/mission.js';
import { createToolRoutes } from './routes/tools.js';
import { createMemoryRoutes } from './routes/memory.js';
import { createSessionSummaryScheduler } from './session-summary-scheduler.js';
import { IdempotencyConflictError, runChatTurn, TurnInProgressError } from './turn.js';

installUnhandledRejectionLogger();

const env = loadEnv(gatewayEnvSchema);
const db = createDb(env.DATABASE_URL);

const tracing = initTracing({
  baseUrl: env.LANGFUSE_BASE_URL,
  publicKey: env.LANGFUSE_PUBLIC_KEY,
  secretKey: env.LANGFUSE_SECRET_KEY,
});
process.stdout.write(
  tracing.enabled ? '[gateway] tracing: acik\n' : `[gateway] tracing: ${tracing.reason}\n`,
);

/**
 * openai-compat saglayicisi TEK bir OpenAI-uyumlu ucu isaret eder; hangi uc
 * oldugunu env belirler. Boylece ayni kod hem yerel Ollama'yi hem bulut
 * saglayicilarini (Gemini/OpenRouter — hepsi OpenAI-uyumlu uc sunar)
 * kullanabilir; saglayici degistirmek KOD degil YAPILANDIRMA isi.
 *
 * Varsayilan bilincli olarak YEREL (Ollama): anahtar verilmemis bir kurulumda
 * hicbir veri makineden cikmaz. `SMITH_LLM_BASE_URL` verilirse o uc kullanilir.
 * EMBEDDING bundan bagimsizdir ve KENDI env dikisini kullanir (asagi bkz.).
 *
 * DIKKAT - BU PASAJ ESKIDEN "embedding daima YEREL kalir, hafiza icerigi
 * disariya gonderilmez" DIYORDU; 2026-08-15 denetiminde YANLIS oldugu icin
 * duzeltildi. Ayni dosyanin asagisi (`SMITH_EMBED_*`) tersini yapiyor ve
 * `scripts/gateway-dev.ps1` bugun `gemini-embedding-001`i
 * generativelanguage.googleapis.com uzerinden kullaniyor: hafizaya yazilan
 * METIN embed edilirken saglayiciya GIDIYOR.
 * Yerellik isteniyorsa `SMITH_EMBED_BASE_URL` yerel bir uca (Ollama)
 * cevrilir - ama bu bir GARANTI degil YAPILANDIRMADIR. Yanlis bir gizlilik
 * garantisi, hic garanti olmamasindan daha tehlikelidir.
 */
const llmBaseUrl = env.SMITH_LLM_BASE_URL ?? `${env.OLLAMA_BASE_URL}/v1`;
process.stdout.write(`[gateway] llm: ${describeChain(env)} @ ${llmBaseUrl}\n`);

/**
 * Router + YEDEK ZINCIRI tek cozucuden gelir (gateway ile worker sapmasin —
 * embedder'da tam bu sapma yasandi). Birincil gecici olarak dusunce (kota/yuk/
 * stall) istek sonraki halkaya gecer; kalici hatalarda (400/401) fail-loud.
 */
const llm = createLlmRouterFromEnv(env, {
  onFallback: ({ role, from, to, reason }) => {
    process.stderr.write(`[gateway] llm yedek: ${role} ${from} -> ${to} (${reason})\n`);
  },
});

// Embedding: kullanici karari (2026-08-13) "Ollama olmasin, API'den kullan" —
// yerel Ollama verimsiz ve cokme kirilganligi vardi. Gemini `gemini-embedding-001`
// @ 768 boyut (Matryoshka), ayni Google anahtari. GIZLILIK NOTU: embed metni
// artik Google'a gidiyor — eski "embedding daima yerel" ilkesi kullanici
// talimatiyla degisti (ses zaten Live'da buluta gidiyordu, tutarli). Env yoksa
// yerel Ollama'ya duser (offline gelistirme icin kapi acik).
const embedder = createEmbedderFromEnv(env);
process.stdout.write(`[gateway] embed: ${embedder.model}\n`);

const queueConnection = createQueueConnection(env.REDIS_URL);
const memoryIndexQueue = createQueue(QueueName.MEMORY_INDEX, queueConnection);
const memoryMaintenanceQueue = createQueue(QueueName.MEMORY_MAINTENANCE, queueConnection);

// Faz 2b: tool-loop turu env bayragi arkasinda (varsayilan KAPALI). Kapaliyken
// mevcut streaming `runChatTurn` yolu aynen calisir; acikken model hafiza
// araclarini (hafizada_ara / hafizaya_kaydet) cagirabilir.
const agentLoopEnabled = env.SMITH_AGENT_LOOP;
const agentRegistry = buildAgentRegistry({ db, embedder });
// NOT: loop-model TUR BASINA kurulur (asagida), startup'ta degil — Gemini
// thought_signature koprusu (llm-loop-model) tura izole bir harita tutar.
// Mission Control atamalari bu kuyruga duser; tuketicisi apps/worker.
const agentRunQueue = createQueue(QueueName.AGENT_RUN, queueConnection);

const app = new Hono();
app.onError(maskedErrorHandler);
const nodeWs = createNodeWebSocket({ app });
nodeWs.wss.options.maxPayload = MAX_TRANSPORT_BYTES;

const WS_TICKET_TTL_MS = 60_000;
const wsTickets = new Map<string, { expiresAt: number; scope: WorkspaceScope }>();
// Bilet kotasi DOGRULANMIS actor basinadir: gecersiz token'li istekler (herkes
// gonderebilir) sahibin kotasini tuketemez.
const wsTicketLimiter = createAttemptLimiter({
  secret: env.SESSION_SECRET,
  policy: WS_TICKET_POLICY,
});
const activeTurns = new Map<string, AbortController>();

app.use('/v1/*', async (c, next) => {
  if (Number(c.req.header('content-length')) > MAX_TRANSPORT_BYTES) {
    return c.json({ error: 'Gövde en fazla 1 MiB olabilir.' }, 413);
  }
  const reader = c.req.raw.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new TypeError('HTTP gövdesi byte içermeli.');
        size += value.byteLength;
        if (size > MAX_TRANSPORT_BYTES) {
          await reader.cancel();
          return c.json({ error: 'Gövde en fazla 1 MiB olabilir.' }, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    c.req.raw = new Request(c.req.raw, { body });
  }
  await next();
});

/**
 * CORS — `CORS_ORIGINS` env'i vardi ama HIC KULLANILMIYORDU: tarayici tabanli
 * istemciler (Tauri webview dahil) `Access-Control-Allow-Origin` gelmeyince
 * yaniti reddediyor, istek sunucuya ulassa bile istemci "baglanamadi" goruyor.
 * Sahada bu, masaustunun otomatik baglanmamasi olarak ortaya cikti.
 *
 * Tauri: dev'de origin `http://localhost:1420`, paketli uygulamada
 * `tauri://localhost` (Windows'ta `https://tauri.localhost`) olur — listeye
 * env uzerinden eklenir. WebSocket el sikismasi CORS'a tabi DEGILDIR; bu
 * middleware yalniz HTTP uclarini (health/login) etkiler.
 */
app.use(
  '/v1/*',
  cors({
    origin: (origin) => (env.CORS_ORIGINS.includes(origin) ? origin : null),
    // PATCH: Mission Control'de ajan profili (SOUL, rol, cihaz) kismi
    // guncelleme ile duzenlenir; POST ile taklit etmek kaynagi yeniden
    // yaratmak anlamina gelirdi.
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

app.get(
  '/v1/health',
  createHealthHandler({
    // pg havuzu: Prisma islem katmanindan bagimsiz, baglanti/yanit sorununu dogrudan olcer.
    db: () => db.pool.query('SELECT 1'),
    // Hazir degilken PING, yeniden baglanma bitene kadar kuyrukta beklerdi (offline
    // kuyruk): hazir olmayan baglanti dogrudan "yok" sayilir.
    redis: () =>
      queueConnection.status === 'ready'
        ? queueConnection.ping()
        : Promise.reject(new Error('redis hazir degil')),
  }),
);

app.post('/v1/ws/ticket', (c) => {
  const authorization = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1]) return c.json({ error: 'Kimlik doğrulama gerekli.' }, 401);

  let ticketScope: WorkspaceScope;
  try {
    ticketScope = verifyAccessToken(env.SESSION_SECRET, match[1]);
  } catch (error) {
    return c.json(
      { error: error instanceof AuthError ? error.message : 'Kimlik doğrulanamadı.' },
      401,
    );
  }

  const waitingMs = wsTicketLimiter.admit(
    wsTicketLimiter.keyFor(resolveRemoteAddress(c), ticketScope.actorId),
  );
  if (waitingMs > 0) return tooManyRequests(c, waitingMs, 'Cok fazla bilet istegi.');

  const now = Date.now();
  for (const [ticket, entry] of wsTickets) {
    if (entry.expiresAt <= now) wsTickets.delete(ticket);
  }
  const ticket = randomBytes(32).toString('base64url');
  const entry = { scope: ticketScope, expiresAt: now + WS_TICKET_TTL_MS };
  wsTickets.set(ticket, entry);
  const expiryTimer = setTimeout(() => {
    if (wsTickets.get(ticket) === entry) wsTickets.delete(ticket);
  }, WS_TICKET_TTL_MS);
  expiryTimer.unref();
  c.header('Cache-Control', 'no-store');
  return c.json({ ticket, expiresInMs: WS_TICKET_TTL_MS }, 201);
});

// Acik kayit VARSAYILAN KAPALI (bkz. routes/auth.ts). Acmak bilincli bir karardir.
const allowRegistration = isFlagOn(process.env.SMITH_ALLOW_REGISTRATION);
process.stdout.write(
  `[gateway] kayit: ${allowRegistration ? 'ACIK (SMITH_ALLOW_REGISTRATION)' : 'kapali'}\n`,
);
app.route(
  '/v1/auth',
  createAuthRoutes({ db, sessionSecret: env.SESSION_SECRET, allowRegistration }),
);

// Live oturumunun (speech-to-speech) hafiza araclari. Sohbet turu devrede
// olmadigi icin hafiza bu ucler uzerinden calisir; tenancy/RLS ayni.
app.route('/v1/tools', createToolRoutes({ db, sessionSecret: env.SESSION_SECRET, embedder }));
app.route(
  '/v1/memory',
  createMemoryRoutes({
    db,
    sessionSecret: env.SESSION_SECRET,
    embedder,
    maintenanceQueue: memoryMaintenanceQueue,
    maintenanceEnabled: env.SMITH_MEMORY_MAINTENANCE !== '0',
  }),
);

// Konusma kaliciligi. Ayni `/v1/tools` tabani altinda AYRI bir router: hafiza
// araclari embedder'a bagli, bu uc degil — ikisini tek dosyada toplamak
// gereksiz bir bagimlilik yaratirdi. Oturum siniri sunucuda karara baglanir;
// istemci oturum kimligi tasimaz (bkz. routes/conversation.ts).
const sessionIdleHours = resolveIdleHours(process.env.SMITH_SESSION_IDLE_HOURS);
app.route(
  '/v1/tools',
  createConversationRoutes({
    db,
    sessionSecret: env.SESSION_SECRET,
    idleHours: sessionIdleHours,
    // Bosta kalan Live oturumunun TEK ozet isi (tuketici: apps/worker).
    summaryScheduler: createSessionSummaryScheduler(
      createQueue(QueueName.SESSION_SUMMARY, queueConnection),
    ),
  }),
);
process.stdout.write(`[gateway] oturum bosta kalma penceresi: ${sessionIdleHours} saat\n`);

// Mission Control (ADR 0007): ekip, gorev panosu, etkinlik akisi. Ayni ucleri
// hem pano penceresi hem Smith'in sesli araclari cagirir.
app.route(
  '/v1/mission',
  createMissionRoutes({ db, sessionSecret: env.SESSION_SECRET, agentRunQueue }),
);

// Gelistirme kisayolu (sifresiz token): NODE_ENV=development VE loopback istek
// sart, aksi halde 403 (bkz. routes/dev-login.ts).
app.route(
  '/v1/dev',
  createDevLoginRoutes({ db, sessionSecret: env.SESSION_SECRET, nodeEnv: env.NODE_ENV }),
);

app.get(
  '/v1/ws',
  nodeWs.upgradeWebSocket((c) => {
    // Slice notu: token query'de tasiniyor; @smith/auth geldiginde ilk
    // frame'e tasinacak (TLS altinda da URL loglara dusebilir).
    let scope: WorkspaceScope | null = null;
    let sessionId: string | null = null;
    const inflight = new Map<string, AbortController>();
    // Device-locus tool cagrilari: tc_id -> cozucu. tool_call yollanir, istemci
    // tool_result ile geri doner. onClose inflight'i abort eder → bridge'ler
    // turn signal uzerinden reddedilir, harita temizlenir.
    const pendingDeviceCalls: PendingDeviceCalls = new Map();

    const send = (ws: { send(data: string): void }, frame: ServerFrame) => {
      ws.send(JSON.stringify(frame));
    };

    return {
      onOpen(_event, ws) {
        try {
          const ticket = c.req.query('ticket');
          if (ticket !== undefined) {
            const entry = wsTickets.get(ticket);
            wsTickets.delete(ticket);
            if (!entry || entry.expiresAt <= Date.now()) {
              throw new AuthError('WebSocket bileti geçersiz veya süresi dolmuş.');
            }
            scope = entry.scope;
          } else {
            const legacyToken = c.req.query('token');
            if (legacyToken !== undefined) {
              // JWT URL'de nginx erisim gunlugune ve istemci komut satirina duser.
              // Varsayilan ACIK (eski istemciler kirilmasin); bayrak yolu kapatir.
              if (isFlagOn(process.env.SMITH_WS_DISABLE_LEGACY_TOKEN)) {
                throw new AuthError('?token= kimlik yolu kapali; /v1/ws/ticket ile bilet alın.');
              }
              console.warn(
                '[gateway] eski WebSocket ?token= kimlik yolu kullanıldı; ileride kapatılacak ' +
                  '(SMITH_WS_DISABLE_LEGACY_TOKEN=1 şimdiden kapatır), istemciyi /v1/ws/ticket akışına geçirin',
              );
            }
            scope = verifyAccessToken(env.SESSION_SECRET, legacyToken ?? '');
          }
        } catch (error) {
          send(ws, {
            type: 'error',
            code: 'unauthenticated',
            message: error instanceof AuthError ? error.message : 'Kimlik dogrulanamadi.',
          });
          ws.close();
        }
      },

      onMessage(event: { data: unknown }, ws) {
        // WSEvents void bekler; async isi bilincli olarak arka plana verilir.
        void handleMessage(event, ws).catch((error: unknown) => {
          console.error(
            `[gateway] WebSocket dispatch hatasi (${error instanceof Error ? error.name : 'unknown'})`,
          );
          try {
            send(ws, {
              type: 'error',
              code: error instanceof ForbiddenError ? 'forbidden' : 'internal',
              message:
                error instanceof ForbiddenError
                  ? 'Bu işlem için yetkiniz yok.'
                  : 'İstek işlenemedi.',
            });
          } catch {
            console.error('[gateway] WebSocket hata framei gonderilemedi');
          }
        });
      },

      onClose() {
        for (const controller of inflight.values()) controller.abort();
        inflight.clear();
      },
    };

    async function handleMessage(
      event: { data: unknown },
      ws: { close(code?: number, reason?: string): void; send(data: string): void },
    ): Promise<void> {
      if (!scope) return;
      const activeScope = scope;

      const rawData = event.data;
      const rawBytes =
        typeof rawData === 'string'
          ? Buffer.byteLength(rawData, 'utf8')
          : Buffer.isBuffer(rawData)
            ? rawData.byteLength
            : rawData instanceof ArrayBuffer
              ? rawData.byteLength
              : null;
      if (rawBytes !== null && rawBytes > MAX_TRANSPORT_BYTES) {
        send(ws, {
          type: 'error',
          code: 'protocol_mismatch',
          message: 'WebSocket frame en fazla 1 MiB olabilir.',
        });
        ws.close(1009, 'Frame çok büyük');
        return;
      }
      const rawText =
        typeof rawData === 'string'
          ? rawData
          : Buffer.isBuffer(rawData)
            ? rawData.toString('utf8')
            : null;
      if (rawText === null) {
        send(ws, {
          type: 'error',
          code: 'protocol_mismatch',
          message: 'Beklenmeyen frame turu (ikili veri desteklenmiyor).',
        });
        return;
      }

      let frame;
      try {
        frame = parseClientFrame(JSON.parse(rawText));
      } catch (error) {
        send(ws, {
          type: 'error',
          code: error instanceof ProtocolError ? error.code : 'protocol_mismatch',
          message: error instanceof Error ? error.message : 'Frame okunamadi.',
        });
        return;
      }

      switch (frame.type) {
        case 'hello': {
          if (frame.protocolVersion !== PROTOCOL_VERSION) {
            send(ws, {
              type: 'error',
              code: 'protocol_mismatch',
              message: `Sunucu protokol v${PROTOCOL_VERSION} konusuyor.`,
            });
            return;
          }
          const candidate = frame.resumeSessionId
            ? await withScope(db.prisma, activeScope, (tx) =>
                findSession(tx, activeScope, frame.resumeSessionId ?? ''),
              )
            : null;
          const session = candidate?.actorId === activeScope.actorId ? candidate : null;
          const active =
            session ??
            (await withScope(db.prisma, activeScope, (tx) =>
              createSession(tx, activeScope, { surface: frame.surface }),
            ));
          sessionId = active.id;
          // Cihaz registry (Faz 3): bu istemci yuzeyini kaydet/tazele. Best-effort
          // — hata hello'yu bozmaz (registry ikincil, sohbet birincil).
          try {
            await withScope(db.prisma, activeScope, (tx) =>
              registerDevice(tx, activeScope, {
                surface: frame.surface,
                name: frame.surface.charAt(0).toUpperCase() + frame.surface.slice(1),
              }),
            );
          } catch (error) {
            console.error('[gateway] cihaz kaydi basarisiz:', error);
          }
          send(ws, {
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            sessionId: active.id,
            capabilities: ['chat'],
          });
          return;
        }

        case 'prompt': {
          if (!sessionId || frame.sessionId !== sessionId) {
            send(ws, {
              type: 'error',
              code: 'protocol_mismatch',
              message: 'Once hello ile oturum acilmali.',
            });
            return;
          }
          // Daralma closure'a tasinmaz; guard sonrasi degeri sabitle.
          const activeSession = sessionId;
          if (frame.content.some((part) => part.kind !== 'text')) {
            send(ws, {
              type: 'error',
              code: 'protocol_mismatch',
              message: 'Görsel ve dosya prompt parçaları henüz desteklenmiyor.',
              sessionId: frame.sessionId,
              messageId: frame.messageId,
            });
            return;
          }
          const text = frame.content
            .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
            .map((p) => p.text)
            .join('\n');

          const turnKey = `${activeScope.workspaceId}:${activeScope.actorId}:${activeSession}`;
          if (activeTurns.has(turnKey)) {
            send(ws, {
              type: 'error',
              code: 'rate_limited',
              message: 'Oturum meşgul; mevcut turun bitmesini bekleyin.',
              sessionId: frame.sessionId,
              messageId: frame.messageId,
              retryAfterMs: 0,
            });
            return;
          }

          const controller = new AbortController();
          activeTurns.set(turnKey, controller);
          inflight.set(frame.messageId, controller);
          const onDelta = (delta: string) =>
            send(ws, {
              type: 'delta',
              sessionId: frame.sessionId,
              messageId: frame.messageId,
              text: delta,
            });
          const indexMessage = ({ sourceId }: { sourceId: string }) =>
            memoryIndexQueue
              .add(
                'index',
                {
                  workspaceId: activeScope.workspaceId,
                  actorId: activeScope.actorId,
                  kind: 'message',
                  sourceId,
                },
                { jobId: `message_${sourceId}` },
              )
              .then(() => undefined);
          try {
            const result = await observe(
              'chat-turn',
              {
                workspaceId: activeScope.workspaceId,
                sessionId: frame.sessionId,
                surface: 'ws',
              },
              () =>
                agentLoopEnabled
                  ? runAgentChatTurn({
                      db,
                      // Tur basina taze model → izole thought_signature koprusu.
                      model: createLlmLoopModel(llm, 'chat'),
                      registry: agentRegistry,
                      // Device-locus araclar bu kopruden istemciye gider. Bugun
                      // kayitli device araci yok → cagrilmaz; plumbing hazir.
                      deviceBridge: createDeviceBridge({
                        emit: (f) => send(ws, f),
                        pending: pendingDeviceCalls,
                        sessionId: frame.sessionId,
                        messageId: frame.messageId,
                      }),
                      indexMessage,
                      idempotencyKey: frame.messageId,
                      scope: activeScope,
                      sessionId: activeSession,
                      userText: text,
                      signal: controller.signal,
                      onDelta,
                    })
                  : runChatTurn({
                      db,
                      llm,
                      embedder,
                      indexMessage,
                      idempotencyKey: frame.messageId,
                      scope: activeScope,
                      sessionId: activeSession,
                      userText: text,
                      signal: controller.signal,
                      onDelta,
                    }).then((r) => ({ ...r, stopReason: 'end_turn' as const })),
            );
            if (result.inputTokens !== undefined && result.outputTokens !== undefined) {
              send(ws, {
                type: 'usage',
                sessionId: frame.sessionId,
                messageId: frame.messageId,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                costMicros: 0,
              });
            }
            send(ws, {
              type: 'done',
              sessionId: frame.sessionId,
              messageId: frame.messageId,
              stopReason: result.stopReason,
            });
          } catch (error) {
            if (controller.signal.aborted) {
              send(ws, {
                type: 'done',
                sessionId: frame.sessionId,
                messageId: frame.messageId,
                stopReason: 'cancelled',
              });
            } else if (error instanceof TurnInProgressError) {
              send(ws, {
                type: 'error',
                code: 'rate_limited',
                message: 'Aynı istek halen işleniyor.',
                sessionId: frame.sessionId,
                messageId: frame.messageId,
                retryAfterMs: error.retryAfterMs,
              });
            } else if (error instanceof AgentTurnIncompleteError) {
              // Neden (result.error) run-turn.ts'te maskeli loglandi; istemciye yalniz genel mesaj.
              const stepLimit = error.stopReason === 'max_steps';
              send(ws, {
                type: 'error',
                code: stepLimit ? 'internal' : 'upstream_unavailable',
                message: stepLimit ? 'Ajan turu adım sınırına takıldı.' : 'Model yanıtı alınamadı.',
                sessionId: frame.sessionId,
                messageId: frame.messageId,
              });
            } else if (error instanceof IdempotencyConflictError) {
              send(ws, {
                type: 'error',
                code: 'protocol_mismatch',
                message: error.message,
                sessionId: frame.sessionId,
                messageId: frame.messageId,
              });
            } else {
              console.error(
                `[gateway] tur hatasi (${error instanceof Error ? error.name : 'unknown'})`,
              );
              send(ws, {
                type: 'error',
                code: 'upstream_unavailable',
                message: 'Model yaniti alinamadi.',
                sessionId: frame.sessionId,
                messageId: frame.messageId,
              });
            }
          } finally {
            if (inflight.get(frame.messageId) === controller) inflight.delete(frame.messageId);
            if (activeTurns.get(turnKey) === controller) activeTurns.delete(turnKey);
          }
          return;
        }

        case 'cancel': {
          inflight.get(frame.messageId)?.abort();
          return;
        }

        case 'tool_result': {
          // Istemcide calisan device-locus aracin sonucu. Bekleyen cagriyi cozer;
          // bilinmeyen/gec kalan tc_id (or. zaman asimindan sonra) sessizce yok
          // sayilir. Oturum uyusmazliginda islenmez (baska baglantiya sizmasin).
          if (!sessionId || frame.sessionId !== sessionId) return;
          resolveDeviceResult(pendingDeviceCalls, frame.toolCallId, {
            ok: frame.ok,
            result: frame.result,
          });
          return;
        }

        case 'ping': {
          send(ws, { type: 'pong', at: frame.at });
          return;
        }
      }
    }
  }),
);

const server = serve(
  { fetch: app.fetch, port: env.PORT, hostname: env.SMITH_GATEWAY_HOST },
  (info) => {
    process.stdout.write(`[gateway] ${formatListenUrl(info)} (env: ${env.NODE_ENV})\n`);
    if (env.NODE_ENV === 'development' && !isLoopbackAddress(info.address)) {
      process.stdout.write(
        `[gateway] UYARI: loopback disinda dinliyor (${info.address}); ag erisimi acik\n`,
      );
    }
  },
);
// node-ws dinleyicisinden ONCE: gecersiz upgrade hedefi sureci dusurmesin.
guardUpgradeTarget(server);
nodeWs.injectWebSocket(server);
