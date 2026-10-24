import { db } from './dexie';
import { settingsRepo } from './settings.repo';
import { diagnoseLibrary } from '@/core/matching/library-diagnostics';

export const libraryDiagnosticsRepo = {
  async snapshot() {
    return db.transaction('r', db.songs, db.songProfiles, db.settings, db.audioJobs, async () => {
      const songs = await db.songs.toArray();
      const profiles = await db.songProfiles.toArray();
      const settings = await settingsRepo.get();
      return diagnoseLibrary(songs, profiles, settings, Date.now(), await db.audioJobs.toArray());
    });
  },
};
