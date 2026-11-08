/** What went wrong and is still wrong, shown in the world console's health; each entry clears when its work next succeeds. */
export class Faults {
  private readonly entries = new Map<string, string>();
  set(key: string, text: string): void { this.entries.set(key, text); }
  clear(...keys: string[]): void { for (const key of keys) this.entries.delete(key); }
  list(): string[] { return [...this.entries.values()]; }
  /** Runs async work whose failure is the fault `key` until it succeeds again; the failure still rejects. */
  track(key: string, label: string, work: () => Promise<void>): Promise<void> {
    return work().then(() => this.clear(key), error => { this.set(key, `${label}：${errorText(error)}`); throw error; });
  }
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
