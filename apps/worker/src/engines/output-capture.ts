export const MAX_ENGINE_OUTPUT_BYTES = 8 * 1024 * 1024;

export class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  private limitNotified = false;

  constructor(
    private readonly maxBytes = MAX_ENGINE_OUTPUT_BYTES,
    private readonly onLimit: () => void = () => undefined,
  ) {}

  get exceeded(): boolean {
    return this.limitNotified;
  }

  get text(): string {
    return Buffer.concat(this.chunks, this.byteLength).toString('utf8');
  }

  append(chunk: Buffer): void {
    const remaining = this.maxBytes - this.byteLength;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      this.chunks.push(kept);
      this.byteLength += kept.length;
    }
    if (chunk.length > remaining && !this.limitNotified) {
      this.limitNotified = true;
      this.onLimit();
    }
  }
}
