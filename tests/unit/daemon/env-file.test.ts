import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDaemonEnvFiles,
  daemonEnvFilePaths,
  parseDaemonEnvText,
} from '../../../src/daemon/env-file';
import { resolveAppPaths } from '../../../src/config/app-paths';

describe('parseDaemonEnvText', () => {
  it('parses the supported dotenv subset', () => {
    const result = parseDaemonEnvText([
      '',
      '# comment',
      'ZAI_CODING_CN_API_KEY=plain',
      'OPENAI_API_KEY="double quoted"',
      "ANTHROPIC_API_KEY='single quoted'",
      ' export HTTPS_PROXY = http://127.0.0.1:7890 ',
      'EMPTY_VALUE=',
      'DUP=first',
      'DUP=second',
    ].join('\n'), '/tmp/daemon.env');

    expect(result.values).toEqual({
      ZAI_CODING_CN_API_KEY: 'plain',
      OPENAI_API_KEY: 'double quoted',
      ANTHROPIC_API_KEY: 'single quoted',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      EMPTY_VALUE: '',
      DUP: 'second',
    });
    expect(result.warnings).toEqual([]);
  });

  it('skips invalid lines with file and line metadata but no secret value', () => {
    const result = parseDaemonEnvText('GOOD=ok\nBAD LINE secret-value\n=missing-key', '/tmp/daemon.env');

    expect(result.values).toEqual({ GOOD: 'ok' });
    expect(result.warnings).toEqual([
      { file: '/tmp/daemon.env', line: 2, reason: 'expected KEY=VALUE' },
      { file: '/tmp/daemon.env', line: 3, reason: 'invalid key' },
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain('secret-value');
  });

  it('does not perform shell expansion or inline comment stripping', () => {
    const result = parseDaemonEnvText('FOO=$BAR\nURL=http://x/#fragment', '/tmp/daemon.env');

    expect(result.values).toEqual({ FOO: '$BAR', URL: 'http://x/#fragment' });
  });
});

describe('daemon env file paths', () => {
  it('uses the app root and resolved profile directory', () => {
    const paths = resolveAppPaths({ rootDir: '/tmp/lark-channel', profile: 'codex' });

    expect(daemonEnvFilePaths(paths)).toEqual({
      global: '/tmp/lark-channel/daemon.env',
      profile: '/tmp/lark-channel/profiles/codex/daemon.env',
    });
  });
});

describe('applyDaemonEnvFiles', () => {
  it('loads global then profile env files and profile overrides global and existing env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-channel-env-'));
    try {
      const paths = resolveAppPaths({ rootDir: root, profile: 'codex' });
      await mkdir(paths.profileDir, { recursive: true });
      await writeFile(join(root, 'daemon.env'), 'SHARED=global\nGLOBAL_ONLY=yes\n', 'utf8');
      await writeFile(join(paths.profileDir, 'daemon.env'), 'SHARED=profile\nPROFILE_ONLY=yes\n', 'utf8');

      const env: NodeJS.ProcessEnv = { SHARED: 'existing' };
      const result = await applyDaemonEnvFiles(paths, { env });

      expect(env).toMatchObject({
        SHARED: 'profile',
        GLOBAL_ONLY: 'yes',
        PROFILE_ONLY: 'yes',
      });
      expect(result.loadedFiles).toEqual([
        join(root, 'daemon.env'),
        join(root, 'profiles', 'codex', 'daemon.env'),
      ]);
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-channel-env-'));
    try {
      const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
      const env: NodeJS.ProcessEnv = {};

      const result = await applyDaemonEnvFiles(paths, { env });

      expect(env).toEqual({});
      expect(result.loadedFiles).toEqual([]);
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
