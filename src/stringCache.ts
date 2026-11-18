/** LRU bounded by entries and estimated UTF-16 storage, including large keys. */
export class StringCache {
  private entries = new Map<string, string | null>();
  private bytes = 0;
  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}
  get sizeBytes() { return this.bytes; }
  get(key: string): string | null | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: string | null): void {
    const cost = (key.length + (value?.length ?? 0)) * 2;
    if (this.entries.has(key)) {
      this.bytes -= (key.length + (this.entries.get(key)?.length ?? 0)) * 2;
      this.entries.delete(key);
    }
    if (cost > this.maxBytes || this.maxEntries <= 0) return;
    while (this.entries.size >= this.maxEntries || this.bytes + cost > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= (oldest.length + (this.entries.get(oldest)?.length ?? 0)) * 2;
      this.entries.delete(oldest);
    }
    this.entries.set(key, value);
    this.bytes += cost;
  }
}
