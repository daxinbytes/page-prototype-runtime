import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

// Existing installations keep their extension path, pairing token and project data.
export async function installationHome({ requested, environment = process.env, userHome = homedir() } = {}) {
  const explicit = requested || environment.PAGE_PROTOTYPE_HOME || environment.BETA_PREVIEW_HOME;
  if (explicit) return resolve(explicit);
  for (const name of ['.page-prototype', '.beta-preview']) {
    const directory = join(userHome, name);
    try { await access(join(directory, 'installation.json')); return directory; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return join(userHome, '.page-prototype');
}
