import { createArchiveStore } from '../src/store.ts';
import { record } from './fixtures.ts';
const store = createArchiveStore({ root: process.argv[2], worldId: 'fish', timeZone: 'Asia/Seoul', agentPreset: 'companion' });
try { for (let i = 0; i < 20; i++) await store.commitRecords([record(`${process.argv[3]}${i}`)]); }
finally { store.close(); }
