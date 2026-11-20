import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
export const e2eSessionRoot = mkdtempSync(join(tmpdir(), 'data-migrator-e2e-'));
process.env.DBF_SESSION_DIR = e2eSessionRoot;
