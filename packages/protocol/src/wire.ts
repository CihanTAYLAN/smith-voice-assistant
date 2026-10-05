import { z } from 'zod';

/**
 * Smith gateway wire sozlesmesi.
 *
 * Bu paket sistemin en degerli varligidir: web, CLI, iOS, watchOS, macOS ve
 * Android istemcileri ayni sozlesmeyi konusur. Cekirdek degisirse istemciler
 * degismez; sozlesme degisirse PROTOCOL_VERSION artar ve gateway iki surumu
 * bir sure birlikte tasir.
 *
 * Kural: buraya eklenen her alan geriye donuk uyumlu olmak zorundadir
 * (opsiyonel veya varsayilanli). Kirici degisiklik surum artirmadan girmez.
 */
export const PROTOCOL_VERSION = 1 as const;
export const MAX_TRANSPORT_BYTES = 1024 * 1024;
export const MAX_PROMPT_CHARS = 32_000;

export const sessionIdSchema = z.string().regex(/^ses_[0-9a-z]{20,32}$/);
export const messageIdSchema = z.string().regex(/^msg_[0-9a-z]{20,32}$/);
export const toolCallIdSchema = z.string().regex(/^tc_[0-9a-z]{20,32}$/);

/** Istemcinin hangi yuzeyden bagli oldugu. Kota ve UX kararlari buna bakar. */
export const clientSurfaceSchema = z.enum([
  'web',
  'cli',
  'ios',
  'watchos',
  'macos',
  'android',
  'windows',
  'channel',
]);
export type ClientSurface = z.infer<typeof clientSurfaceSchema>;

export const contentPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('image'),
    mediaType: z.string(),
    /** Buyuk ikili veri wire'da tasinmaz; blob referansi tasinir. */
    blobRef: z.string(),
  }),
  z.object({
    kind: z.literal('file'),
    name: z.string(),
    mediaType: z.string(),
    blobRef: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  }),
]);
export type ContentPart = z.infer<typeof contentPartSchema>;

// ---------------------------------------------------------------------------
// Istemci -> Gateway
// ---------------------------------------------------------------------------

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int().positive(),
    surface: clientSurfaceSchema,
    /** Istemci surumu; sunucu tarafli uyumluluk kararlari icin. */
    clientVersion: z.string().min(1),
    /** Kopan baglantiyi kaldigi yerden surdurmek icin. */
    resumeSessionId: sessionIdSchema.optional(),
  }),
  z.object({
    type: z.literal('prompt'),
    sessionId: sessionIdSchema,
    messageId: messageIdSchema,
    content: z
      .array(contentPartSchema)
      .min(1)
      .superRefine((parts, context) => {
        const textLength = parts
          .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
          .map((part) => part.text)
          .join('\n').length;
        if (textLength > MAX_PROMPT_CHARS) {
          context.addIssue({
            code: 'custom',
            message: `Prompt metni en fazla ${MAX_PROMPT_CHARS.toLocaleString('tr-TR')} karakter olabilir.`,
          });
        }
      }),
    /** Ayni messageId ile tekrar gonderim yan etki uretmez. */
    idempotencyKey: z.string().min(8).optional(),
  }),
  z.object({
    type: z.literal('cancel'),
    sessionId: sessionIdSchema,
    messageId: messageIdSchema,
  }),
  z.object({
    type: z.literal('tool_result'),
    sessionId: sessionIdSchema,
    toolCallId: toolCallIdSchema,
    /** Istemci tarafinda calisan araclarin sonucu (or. cihaz konumu). */
    ok: z.boolean(),
    result: z.unknown(),
  }),
  z.object({ type: z.literal('ping'), at: z.number().int().nonnegative() }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

// ---------------------------------------------------------------------------
// Gateway -> Istemci
// ---------------------------------------------------------------------------

export const errorCodeSchema = z.enum([
  'unauthenticated',
  'forbidden',
  'quota_exceeded',
  'protocol_mismatch',
  'rate_limited',
  'tool_denied',
  'upstream_unavailable',
  'internal',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const serverFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    protocolVersion: z.number().int().positive(),
    sessionId: sessionIdSchema,
    /** Sunucunun bu istemci icin destekledigi yetenekler. */
    capabilities: z.array(z.string()),
  }),
  z.object({
    type: z.literal('delta'),
    sessionId: sessionIdSchema,
    messageId: messageIdSchema,
    /** Artimli metin parcasi; istemci bunlari birlestirir. */
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_call'),
    sessionId: sessionIdSchema,
    messageId: messageIdSchema,
    toolCallId: toolCallIdSchema,
    name: z.string().min(1),
    input: z.unknown(),
    /** Kullanici onayi gerekiyorsa istemci onay UI'i gosterir. */
    requiresApproval: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('usage'),
    sessionId: sessionIdSchema,
    messageId: messageIdSchema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** Kota ve faturalama bu alani tuketir. */
    costMicros: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('done'),
    sessionId: sessionIdSchema,
    messageId: messageIdSchema,
    stopReason: z.enum(['end_turn', 'max_tokens', 'cancelled', 'error']),
  }),
  z.object({
    type: z.literal('error'),
    code: errorCodeSchema,
    /** Kullaniciya gosterilebilir, secret icermeyen mesaj. */
    message: z.string(),
    sessionId: sessionIdSchema.optional(),
    messageId: messageIdSchema.optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('pong'), at: z.number().int().nonnegative() }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Gelen ham veriyi sozlesmeye gore dogrular. Dogrulanmamis frame islenmez. */
export function parseClientFrame(raw: unknown): ClientFrame {
  const result = clientFrameSchema.safeParse(raw);
  if (!result.success) {
    throw new ProtocolError(
      `Gecersiz istemci frame'i: ${result.error.issues.map((i) => i.message).join('; ')}`,
      'protocol_mismatch',
    );
  }
  return result.data;
}

export function parseServerFrame(raw: unknown): ServerFrame {
  const result = serverFrameSchema.safeParse(raw);
  if (!result.success) {
    throw new ProtocolError(
      `Gecersiz sunucu frame'i: ${result.error.issues.map((i) => i.message).join('; ')}`,
      'protocol_mismatch',
    );
  }
  return result.data;
}

/** Istemci ile sunucu surumleri uyumlu mu. */
export function isProtocolCompatible(clientVersion: number): boolean {
  return clientVersion === PROTOCOL_VERSION;
}
