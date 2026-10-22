/**
 * Masks exact configured byte strings in a streaming output channel without
 * changing output length. Keeping lengths stable preserves existing byte cursors.
 */
export class SecretOutputRedactor {
  private readonly secrets: Buffer[];
  private readonly maxLength: number;
  private pending = Buffer.alloc(0);
  private pendingMask = Buffer.alloc(0);
  private finished = false;

  constructor(values: readonly (string | Buffer)[]) {
    const unique = new Map<string, Buffer>();
    for (const value of values) {
      const bytes = Buffer.from(value);
      if (bytes.length > 0) unique.set(bytes.toString('hex'), bytes);
      else bytes.fill(0);
    }
    this.secrets = [...unique.values()];
    this.maxLength = this.secrets.reduce((max, value) => Math.max(max, value.length), 0);
  }

  push(chunk: Buffer): Buffer {
    if (this.finished) throw new Error('Output redactor is already finished');
    if (!this.secrets.length) return Buffer.from(chunk);

    const combined = Buffer.concat([this.pending, chunk]);
    const mask = Buffer.alloc(combined.length);
    this.pendingMask.copy(mask, 0, 0, this.pendingMask.length);
    this.markMatches(combined, mask);

    // Retain only a suffix that could still become a secret when the next
    // output chunk arrives. Holding every last maxLength-1 bytes stalls PTYs.
    let safeLength = combined.length;
    const earliest = Math.max(0, combined.length - this.maxLength + 1);
    for (let start = earliest; start < combined.length; start++) {
      const length = combined.length - start;
      if (this.secrets.some(secret => length < secret.length && secret.subarray(0, length).equals(combined.subarray(start)))) {
        safeLength = start;
        break;
      }
    }
    const output = Buffer.from(combined.subarray(0, safeLength));
    for (let i = 0; i < safeLength; i++) if (mask[i]) output[i] = 0x2a;

    this.pending.fill(0);
    this.pendingMask.fill(0);
    this.pending = Buffer.from(combined.subarray(safeLength));
    this.pendingMask = Buffer.from(mask.subarray(safeLength));
    combined.fill(0);
    mask.fill(0);
    return output;
  }

  finish(): Buffer {
    if (this.finished) return Buffer.alloc(0);
    this.finished = true;
    const mask = Buffer.from(this.pendingMask);
    this.markMatches(this.pending, mask);

    // If the output cap or a disconnect cuts a secret at the end, hide its
    // recognizable prefix too instead of releasing a partial credential.
    for (let start = 0; start < this.pending.length; start++) {
      const remaining = this.pending.length - start;
      for (const secret of this.secrets) {
        if (remaining < secret.length && secret.subarray(0, remaining).equals(this.pending.subarray(start))) {
          mask.fill(1, start);
          break;
        }
      }
    }

    const output = Buffer.from(this.pending);
    for (let i = 0; i < output.length; i++) if (mask[i]) output[i] = 0x2a;
    this.pending.fill(0);
    this.pendingMask.fill(0);
    mask.fill(0);
    for (const secret of this.secrets) secret.fill(0);
    this.secrets.length = 0;
    return output;
  }

  private markMatches(source: Buffer, mask: Buffer) {
    for (const secret of this.secrets) {
      let from = 0;
      while (from <= source.length - secret.length) {
        const at = source.indexOf(secret, from);
        if (at < 0) break;
        mask.fill(1, at, at + secret.length);
        from = at + 1;
      }
    }
  }
}
