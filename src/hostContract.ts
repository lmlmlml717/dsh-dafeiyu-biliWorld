/**
 * 给宿主包补类型声明的接口合并文件：本插件用到的请求用途与消息来源在这里登记。
 *
 * 导出：无（结尾是 `export {}`），全部靠 `declare module` 往 @deepseek-ai/dsh-llm 里加键。
 * 调用方：runtime.ts 以 `import './hostContract.ts'` 引入；放在哪里都行，但必须被加载一次才生效。
 * 依赖：只依赖宿主 llm 包的类型，运行时不产生任何副作用。
 *
 * 坑：这里登记 'compaction' 是因为插件自己发压缩请求，而宿主的请求用途表是封闭的；宿主自带的压缩包也登记了
 * 同名同类型的键，接口合并时两处必须一致。插件可能被用来替换宿主压缩，所以不能指望宿主那条声明在场。
 */
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

  // 每个来源都自带 kind：宿主据此判断这条消息算不算「用户说的话」，归档、去重和界面显示都看它。
  interface MessageSourceMap {
    'dsh-world-history': { kind: 'dsh-world-history'; form: 'recall' };
    'dsh-world-summary-input': { kind: 'dsh-world-summary-input' };
    'dsh-world-life': {
      kind: 'dsh-world-life';
      /**
       * 同是「生活线」的消息，来源不同，转发规则也不同（0.8.20）：
       *   alarm      —— 闹钟到点，她自己开的一轮，回复要推给主人；
       *   early-stop —— 提前收工的问话，不推（她自己知道就行）；
       *   bili-wake  —— B 站定时唤醒，分享由她按 prompt 自己发 QQ，不再重复转发。
       * 缺省按 alarm 处理，兼容旧代码与旧消息。
       */
      lifeKind?: 'alarm' | 'early-stop' | 'bili-wake';
    };
    'dsh-world-channel-context': { kind: 'dsh-world-channel-context'; form: 'recall'; forMessageId?: import('@deepseek-ai/dsh-llm').MessageId };
    /** 门外有程序敲了一下门（阳台那条线）：「外面有人等着」，不是谁发来的话。 */
    'dsh-world-outside': { kind: 'dsh-world-outside'; form: 'ring' };
    /** QQ 的一轮完成了却没说出能发的话：提醒她对方还在等，不是谁发来的话，不进归档。 */
    'dsh-world-reply-nudge': { kind: 'dsh-world-reply-nudge' };
  }
}
export {};
