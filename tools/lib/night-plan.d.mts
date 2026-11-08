export function windowsOf(cfg: any): any;
export function occurrences(cfg: any, now?: number): any;
export function historyOf(state?: {}, now?: number): {
    schema: number;
    date: string;
    wakes: number;
    wokeAt: any;
    usedCount: any;
    skippedWindows: any[];
};
export function isPending(state: any, now?: number): boolean;
export function makePlan(cfg: any, state?: {}, now?: number, random?: () => number): {};
export function completePlan(state: any, now?: number): any;
export function dayOf(value?: number): string;
export function maxWakes(cfg: any): number;
export function inWindow(cfg: any, now?: number): any;
