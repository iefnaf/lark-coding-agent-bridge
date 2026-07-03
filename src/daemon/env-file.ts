import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPaths } from '../config/app-paths';

export interface DaemonEnvWarning {
  file: string;
  line: number;
  reason: string;
}

export interface ParsedDaemonEnv {
  values: Record<string, string>;
  warnings: DaemonEnvWarning[];
}

export interface DaemonEnvApplyResult {
  loadedFiles: string[];
  warnings: DaemonEnvWarning[];
}

export interface DaemonEnvApplyOptions {
  env?: NodeJS.ProcessEnv;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function daemonEnvFilePaths(paths: AppPaths): { global: string; profile: string } {
  return {
    global: join(paths.rootDir, 'daemon.env'),
    profile: join(paths.profileDir, 'daemon.env'),
  };
}

export function parseDaemonEnvText(text: string, file: string): ParsedDaemonEnv {
  const values: Record<string, string> = {};
  const warnings: DaemonEnvWarning[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();

    const eq = line.indexOf('=');
    if (eq < 0) {
      warnings.push({ file, line: lineNumber, reason: 'expected KEY=VALUE' });
      return;
    }

    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      warnings.push({ file, line: lineNumber, reason: 'invalid key' });
      return;
    }

    values[key] = unquoteValue(line.slice(eq + 1).trim());
  });

  return { values, warnings };
}

function unquoteValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export async function applyDaemonEnvFiles(
  paths: AppPaths,
  options: DaemonEnvApplyOptions = {},
): Promise<DaemonEnvApplyResult> {
  const env = options.env ?? process.env;
  const files = daemonEnvFilePaths(paths);
  const loadedFiles: string[] = [];
  const warnings: DaemonEnvWarning[] = [];

  for (const file of [files.global, files.profile]) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    loadedFiles.push(file);
    const parsed = parseDaemonEnvText(text, file);
    warnings.push(...parsed.warnings);
    for (const [key, value] of Object.entries(parsed.values)) {
      env[key] = value;
    }
  }

  return { loadedFiles, warnings };
}
