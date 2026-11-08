declare module '@deepseek-ai/dsh-llm' {
  /**
   * 0.2.2-rc.1 起 `llm.stream()` 的 `purpose` 由开放字符串改成封闭映射：只有在这里登记过的键才允许传。
   * 本插件自己发压缩请求（`src/compaction.ts` 用 `purpose: 'compaction'`），所以由生产方登记这个键。
   * 宿主自带的 `@deepseek-ai/dsh-compaction-basic` 也登记了同名键、类型同为 `true`，接口合并时两处一致；
   * 插件被用来替换宿主压缩时，那条路径不保证在场，因此这里不依赖宿主包的声明。
   */
  interface LlmRequestPurposeMap {
    'compaction': true;
  }

  interface MessageSourceMap {
    'dsh-world-history': { kind: 'dsh-world-history'; form: 'recall' };
    'dsh-world-summary-input': { kind: 'dsh-world-summary-input' };
    'dsh-world-life': { kind: 'dsh-world-life' };
    'dsh-world-channel-context': { kind: 'dsh-world-channel-context'; form: 'recall'; forMessageId?: import('@deepseek-ai/dsh-llm').MessageId };
    /** 门外有程序敲了一下门（阳台那条线）：「外面有人等着」，不是谁发来的话。 */
    'dsh-world-outside': { kind: 'dsh-world-outside'; form: 'ring' };
    /** QQ 的一轮完成了却没说出能发的话：提醒她对方还在等，不是谁发来的话，不进归档。 */
    'dsh-world-reply-nudge': { kind: 'dsh-world-reply-nudge' };
  }
}
export {};
