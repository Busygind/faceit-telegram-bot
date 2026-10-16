import { api, db, fetch, InputFile } from 'sdk';
import settings from './private-settings.js';
import { validateSettings } from './settings.js';
import { createSealer } from './credentials.js';
import { Store } from './store.js';
import { createFaceitService } from './faceit.js';
import { renderReportCard } from './card.js';
import { createBot } from './bot.js';

export function createRuntime() {
  validateSettings(settings);
  return createBot({
    api, store: new Store(db), settings,
    sealer: createSealer({ keyHex: settings.encryptionKeyHex, keyId: settings.encryptionKeyId }),
    faceit: createFaceitService({ fetch, key: settings.faceitKey }),
    renderCard: renderReportCard,
    inputFile: (bytes, name) => new InputFile(bytes, name, { type: 'image/png' }),
  });
}
