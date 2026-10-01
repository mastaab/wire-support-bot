/**
 * Keys of support requests the bot is changing in the tracker right now. A resolve moves the
 * ticket first and stores the new category only after reading the SLAs, seconds later; the
 * watch skips a key while it is here, so it never announces the bot's own change as the desk's.
 * In memory, for this process only.
 */
export class SupportRequestWrites {
  private readonly active = new Map<string, number>();

  async during<T>(key: string, write: () => Promise<T>): Promise<T> {
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await write();
    } finally {
      const left = (this.active.get(key) ?? 1) - 1;
      if (left > 0) this.active.set(key, left);
      else this.active.delete(key);
    }
  }

  has(key: string): boolean {
    return this.active.has(key);
  }
}
