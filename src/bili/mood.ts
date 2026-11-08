import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../tools/lib/paths.mjs'
import { config } from '../../tools/lib/config.mjs'
import { mood as libMood, fed as libFed } from '../../tools/lib/mood.mjs'
import type { BiliMood } from '../console/routes.ts'

const DEFAULTS = { hungerCap: 70, mealGain: 7, decayPerTick: 6, moodBase: 62, hungryMoodPenalty: 1 }
function moodFile() { return dataPath('mood.json') }

function opts(): typeof DEFAULTS {
  try { return { ...DEFAULTS, ...((config() as any)?.mood || {}) } } catch { return { ...DEFAULTS } }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(moodFile(), 'utf8')) } catch { return { value: 62, hunger: 0, updatedAt: null, day: '' } }
}

function writeState(st: any) {
  try {
    fs.mkdirSync(path.dirname(moodFile()), { recursive: true })
    fs.writeFileSync(moodFile(), JSON.stringify(st, null, 2) + '\n')
  } catch {}
}

function dayKey(d = new Date()): string { return d.toLocaleDateString('sv-SE') }

export function getBiliMood(): BiliMood {
  const st = readState()
  return {
    value: st.value ?? 62,
    hunger: st.hunger ?? 0,
    updatedAt: st.updatedAt ?? null,
    day: st.day ?? '',
    opts: opts(),
  }
}

export function setBiliMood(value: number): BiliMood {
  const st = readState()
  st.value = Math.max(0, Math.min(100, Math.round(value)))
  st.updatedAt = new Date().toISOString()
  st.day = st.day || dayKey()
  writeState(st)
  return getBiliMood()
}

export function feedBili(level?: number): BiliMood {
  const st = libFed(level)
  return {
    value: st.value,
    hunger: st.hunger,
    updatedAt: st.updatedAt,
    day: st.day,
    opts: opts(),
  }
}
