/** 读取合并后的配置（不缓存：改完保存立刻生效 —— bili-whale 的实战要求）。 */
export function config(): any;
export { configPath } from "./paths.mjs";
export namespace DEFAULTS {
    namespace identity {
        let name: string;
        let ownerTitle: string;
        let selfClaim: string;
    }
    namespace owner {
        export let mid: string;
        let name_1: string;
        export { name_1 as name };
    }
    namespace night {
        let windows: {
            start: string;
            end: string;
            wakes: number;
        }[];
        let skipChance: number;
        let minGapMin: number;
        let maxVideos: number;
    }
    namespace preferences {
        let like: string[];
        let dislike: string[];
        let keywords: never[];
    }
    namespace share {
        let enabled: boolean;
        let via: string;
        let minScore: number;
    }
    namespace quota {
        let shareDaily: number;
        let sameVideoDays: number;
    }
    namespace ledger {
        let enabled_1: boolean;
        export { enabled_1 as enabled };
        export let dailyBudget: number;
        export let mineWorkspace: string;
        export namespace price {
            let inputPerM: number;
            let cachePerM: number;
            let outputPerM: number;
        }
        export let balanceUrl: string;
        export let apiKey: string;
        export let balanceTimeoutMs: number;
        export let promptInQQ: boolean;
    }
    namespace guard {
        let dryRun: boolean;
        let minGapSec: number;
        let dupThreshold: number;
        let banned: string[];
    }
    namespace diary {
        let push: boolean;
    }
    namespace mood {
        let hungerCap: number;
        let mealGain: number;
        let decayPerTick: number;
        let moodBase: number;
        let hungryMoodPenalty: number;
    }
    namespace bilibili {
        namespace freeRoam {
            let enabled_2: boolean;
            export { enabled_2 as enabled };
            export let unlimited: boolean;
            let maxVideos_1: number;
            export { maxVideos_1 as maxVideos };
            export let maxMinutes: number;
            export let restMin: number;
        }
        let reportHistory: boolean;
        namespace danmaku {
            let enabled_3: boolean;
            export { enabled_3 as enabled };
            export let dailyMax: number;
        }
        namespace dynamic {
            let enabled_4: boolean;
            export { enabled_4 as enabled };
            let dailyMax_1: number;
            export { dailyMax_1 as dailyMax };
            export let times: string[];
        }
        namespace react {
            let like_1: boolean;
            export { like_1 as like };
            export let coin: boolean;
            export let likeDaily: number;
            export let coinDaily: number;
        }
        namespace imageComment {
            let enabled_5: boolean;
            export { enabled_5 as enabled };
            let dailyMax_2: number;
            export { dailyMax_2 as dailyMax };
        }
        namespace replies {
            let enabled_6: boolean;
            export { enabled_6 as enabled };
            let dailyMax_3: number;
            export { dailyMax_3 as dailyMax };
        }
        namespace fishCircle {
            let enabled_7: boolean;
            export { enabled_7 as enabled };
        }
        namespace follow {
            let enabled_8: boolean;
            export { enabled_8 as enabled };
        }
        let ownMid: string;
        let ownBvids: never[];
    }
}
