/**
 * 故障登记表：记住「什么坏了、还没好」，由世界控制台的健康列表如实展示。
 *
 * 导出：Faults（登记、清除、列举，以及包住一段异步工作的 track）、errorText（错误转一行文字）。
 * 调用方：index.ts、runtime.ts、sourceArchive.ts 与生活线各自持有一份；控制台通过回调汇总成健康列表。
 * 依赖：无，只用内存里的 Map，因此可以在任何初始化顺序里先建出来。
 *
 * 坑：键由调用方给，同一个键后写覆盖先写；条目只在对应工作下一次成功时才消失，所以最后一次失败会一直挂着 ——
 * 这是有意的：宁可显示旧故障，也不把还没修好的东西画成正常。
 */
/** What went wrong and is still wrong, shown in the world console's health; each entry clears when its work next succeeds. */
export class Faults {
  private readonly entries = new Map<string, string>();
  set(key: string, text: string): void { this.entries.set(key, text); }
  clear(...keys: string[]): void { for (const key of keys) this.entries.delete(key); }
  list(): string[] { return [...this.entries.values()]; }
  /** Runs async work whose failure is the fault `key` until it succeeds again; the failure still rejects. */
  track(key: string, label: string, work: () => Promise<void>): Promise<void> {
    // 失败先登记再原样抛出：登记是为了让控制台看得见，抛出是为了让调用方仍能决定吞掉还是中断。
    return work().then(() => this.clear(key), error => { this.set(key, `${label}：${errorText(error)}`); throw error; });
  }
}
/**
 * 把任意抛出物压成一行可读文字，给健康列表、日志和工具回包共用。
 * @param error Error、字符串或任何被 throw 出来的值。
 * @returns Error 取 message，其余走 String()；本身不抛错，null、undefined 也会变成字面量。
 */
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
