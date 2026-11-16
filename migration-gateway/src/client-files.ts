import * as fs from 'fs';
import * as path from 'path';
import type { ClientFiles } from './server';

/** Serve build artifacts only; malformed URLs and escaped paths are missing files. */
export function clientFromDir(dir: string): ClientFiles {
  const root = path.resolve(dir);
  return (urlPath) => {
    try {
      const decoded = decodeURIComponent(urlPath);
      if (
        !decoded.startsWith('/') ||
        decoded.includes('\\') ||
        decoded.includes('\0')
      )
        return undefined;
      const file = path.resolve(root, '.' + decoded);
      if (!file.startsWith(root + path.sep)) return undefined;
      return fs.readFileSync(file);
    } catch {
      return undefined;
    }
  };
}
