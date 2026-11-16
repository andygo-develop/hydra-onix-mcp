/**
 * `hydra-onix-mcp auth logout`: forget this app's session.
 *
 * Removes this app URL's entry from the credentials file (other app URLs stay)
 * and, unless `--keep-profile`, deletes the dedicated browser profile: the
 * signed-in identity provider session lives there, and would otherwise sign
 * the same user straight back in on the next login. Works on a corrupt file.
 */
import { rm, stat } from 'node:fs/promises';

import { CorruptCredentialsError, CredentialStore } from '../../../auth/store.js';
import { appUrl } from '../../../constants.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';

export interface AuthLogoutOptions {
  keepProfile?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface AuthLogoutResult {
  credentialsRemoved: boolean;
  profileRemoved: boolean;
  credentialsFile: string;
  browserProfile: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function runAuthLogout(o: AuthLogoutOptions = {}): Promise<AuthLogoutResult> {
  const env = o.env ?? process.env;
  const paths = hydraPaths(env);
  const store = new CredentialStore(paths, appUrl(env));

  return store.withLock(async () => {
    let credentialsRemoved: boolean;
    try {
      credentialsRemoved = (await store.read()) !== undefined;
    } catch (error) {
      if (!(error instanceof CorruptCredentialsError)) throw error;
      credentialsRemoved = true;
    }
    await store.remove();

    let profileRemoved = false;
    if (!o.keepProfile && (await exists(paths.browserProfile))) {
      await rm(paths.browserProfile, { recursive: true, force: true });
      profileRemoved = true;
    }
    return {
      credentialsRemoved,
      profileRemoved,
      credentialsFile: paths.credentialsFile,
      browserProfile: paths.browserProfile,
    };
  });
}

export async function authLogoutCommand(o: AuthLogoutOptions = {}): Promise<void> {
  const result = await runAuthLogout(o);
  if (result.credentialsRemoved) {
    logger.success(`Signed out: removed the stored session from ${result.credentialsFile}`);
  } else {
    logger.info('No stored session to remove');
  }
  if (result.profileRemoved) {
    logger.success(`Deleted the login browser profile ${result.browserProfile}`);
  } else if (o.keepProfile) {
    logger.info(`Kept the login browser profile ${result.browserProfile}`);
  }
}
