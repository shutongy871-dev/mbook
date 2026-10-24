import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { summarizeAudio } from '../core/playback/audio-analysis.ts';

const records = JSON.parse(await readFile('.artifacts/audio/prepared.json', 'utf8'));
const features = {};
const credits = records.map(({ rms20Hz, ...record }) => {
  features[record.id] = summarizeAudio(rms20Hz);
  const calm = record.source.startsWith('calm/');
  return { ...record, artist: calm ? 'Juhani Junkala' : 'Alexander Ehlers',
    sourcePage: calm ? 'https://opengameart.org/content/jrpg-pack-4-calm' : 'https://opengameart.org/content/free-music-pack',
    license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    modifications: '72-second excerpt; loop extension where source is shorter; mono 32kHz AAC 96kbps; peak normalization and boundary fades',
  };
});
await writeFile('assets/cc0/features.json', JSON.stringify(features, null, 2));
await writeFile('public/cc0/credits.json', JSON.stringify(credits, null, 2));
await mkdir('.artifacts/audio/legacy', { recursive: true });
for (const name of await readdir('public/cc0'))
  if (name.endsWith('.wav')) await rename(`public/cc0/${name}`, `.artifacts/audio/legacy/${name}`);
console.log(JSON.stringify(features, null, 2));
