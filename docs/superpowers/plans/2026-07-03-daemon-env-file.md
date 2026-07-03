# Daemon Env File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load daemon-specific environment variables from global and profile dotenv files before provider resolution or agent spawning.

**Architecture:** Add a focused daemon env module that parses a small dotenv subset, resolves global/profile env file paths from `AppPaths`, and applies parsed values to `process.env`. Call it immediately after `resolveProfileRuntime()` in `runStart`, before logger setup, preflight, runtime/provider resolution, and agent construction. Update service UX/docs to advertise the env files without serializing secrets into OS service definitions.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest, existing `AppPaths`, existing structured logger, existing daemon service builders.

---

## File Structure

- Create `src/daemon/env-file.ts`
  - Owns daemon env file path construction, dotenv parsing, file loading, merge order, and `process.env` application.
  - Exports pure parser helpers for unit testing and one runtime helper for `runStart`.
- Create `tests/unit/daemon/env-file.test.ts`
  - Tests parser behavior, merge behavior, missing files, invalid lines, and process env application.
- Modify `src/cli/commands/start.ts`
  - Calls env loader after `resolveProfileRuntime()` and before `configureLogger()`, `preFlightChecks()`, `loadTelemetryAdapter()`, and `createRuntimeAgent()`.
  - Logs parser warnings after logger is configured, without logging values.
- Modify `src/cli/commands/service.ts`
  - Adds discoverability text for daemon env file locations after start/restart dispatch.
- Modify `README.md` and `README.zh.md`
  - Documents daemon env files, restart requirement, and provider/model boundary.
- Modify `tests/unit/daemon/profile-args.test.ts`
  - Adds assertions that generated launchd/systemd/Windows service text still does not contain provider key material.

---

### Task 1: Add dotenv parser and path helpers

**Files:**
- Create: `src/daemon/env-file.ts`
- Test: `tests/unit/daemon/env-file.test.ts`

- [ ] **Step 1: Write failing parser tests**

Add `tests/unit/daemon/env-file.test.ts`:

```ts
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
```

- [ ] **Step 2: Run parser tests to verify they fail**

Run:

```bash
pnpm vitest run tests/unit/daemon/env-file.test.ts
```

Expected: FAIL because `src/daemon/env-file.ts` does not exist.

- [ ] **Step 3: Implement minimal parser and loader**

Create `src/daemon/env-file.ts`:

```ts
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
```


- [ ] **Step 4: Run parser tests to verify they pass**

Run:

```bash
pnpm vitest run tests/unit/daemon/env-file.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit parser and loader**

```bash
git add src/daemon/env-file.ts tests/unit/daemon/env-file.test.ts
git commit -m "feat: add daemon env file loader"
```

---

### Task 2: Load daemon env during run startup

**Files:**
- Modify: `src/cli/commands/start.ts:22-101`
- Modify: `tests/unit/daemon/env-file.test.ts`
- Modify: `tests/unit/cli/start-agent-factory.test.ts`

- [ ] **Step 1: Add characterization test for startup-level application semantics**

Append to the `applyDaemonEnvFiles` describe block in `tests/unit/daemon/env-file.test.ts`:

```ts
  it('applies env before code reads process-style environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-channel-env-'));
    try {
      const paths = resolveAppPaths({ rootDir: root, profile: 'pi' });
      await mkdir(paths.profileDir, { recursive: true });
      await writeFile(join(root, 'daemon.env'), 'ZAI_CODING_CN_API_KEY=global-key\n', 'utf8');
      await writeFile(join(paths.profileDir, 'daemon.env'), 'ZAI_CODING_CN_API_KEY=profile-key\n', 'utf8');

      const env: NodeJS.ProcessEnv = {};
      await applyDaemonEnvFiles(paths, { env });

      expect(env.ZAI_CODING_CN_API_KEY).toBe('profile-key');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
```

This documents the behavior used by `runStart`: once called with resolved `appPaths`, env values are available through the process environment before provider/agent code reads them.

- [ ] **Step 2: Add failing source-order test for `runStart` wiring**

Add to `tests/unit/cli/start-agent-factory.test.ts` near the existing source-order tests:

```ts
  it('loads daemon env before startup code resolves providers or creates agents', async () => {
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const runStartIndex = source.indexOf('export async function runStart');
    const envIndex = source.indexOf('await applyDaemonEnvFiles(appPaths)', runStartIndex);
    const loggerIndex = source.indexOf('configureLogger({ logsDir: appPaths.logsDir })', runStartIndex);
    const preflightIndex = source.indexOf('await preFlightChecks({', runStartIndex);
    const telemetryIndex = source.indexOf('await loadTelemetryAdapter({', runStartIndex);
    const agentIndex = source.indexOf('createRuntimeAgent(profileConfig', runStartIndex);

    expect(runStartIndex).toBeGreaterThanOrEqual(0);
    expect(envIndex).toBeGreaterThanOrEqual(0);
    expect(loggerIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(telemetryIndex).toBeGreaterThanOrEqual(0);
    expect(agentIndex).toBeGreaterThanOrEqual(0);
    expect(envIndex).toBeLessThan(loggerIndex);
    expect(envIndex).toBeLessThan(preflightIndex);
    expect(envIndex).toBeLessThan(telemetryIndex);
    expect(envIndex).toBeLessThan(agentIndex);
  });
```

This test fails before wiring because `applyDaemonEnvFiles(appPaths)` is absent, and it prevents future regressions that move env loading after provider/runtime setup.

- [ ] **Step 3: Run targeted tests to verify expected state**

Run:

```bash
pnpm vitest run tests/unit/daemon/env-file.test.ts tests/unit/cli/start-agent-factory.test.ts
```

Expected before wiring: `env-file.test.ts` passes after Task 1, and the new `start-agent-factory.test.ts` source-order test fails because `applyDaemonEnvFiles(appPaths)` is not wired yet.

- [ ] **Step 4: Wire loader into `runStart` before preflight and agent creation**

Modify `src/cli/commands/start.ts`:

Add import near daemon/runtime imports:

```ts
import { applyDaemonEnvFiles } from '../../daemon/env-file';
```

After line where `profileConfig` is set and before `configureLogger({ logsDir: appPaths.logsDir });`, add:

```ts
  const daemonEnvResult = await applyDaemonEnvFiles(appPaths);
  configureLogger({ logsDir: appPaths.logsDir });
  for (const warning of daemonEnvResult.warnings) {
    log.warn('daemon-env', 'invalid-line', warning);
  }
  if (daemonEnvResult.loadedFiles.length > 0) {
    log.info('daemon-env', 'loaded', {
      files: daemonEnvResult.loadedFiles,
      count: daemonEnvResult.loadedFiles.length,
    });
  }
```

Remove the original standalone `configureLogger({ logsDir: appPaths.logsDir });` line so logger configuration happens once.

Important: do not log parsed values. `warning` contains only file, line, reason.

- [ ] **Step 5: Run focused typecheck/test**

Run:

```bash
pnpm vitest run tests/unit/daemon/env-file.test.ts tests/unit/cli/start-agent-factory.test.ts
pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit startup wiring**

```bash
git add src/cli/commands/start.ts tests/unit/daemon/env-file.test.ts tests/unit/cli/start-agent-factory.test.ts
git commit -m "feat: load daemon env during startup"
```

---

### Task 3: Add service UX and service-definition safety tests

**Files:**
- Modify: `src/cli/commands/service.ts:245-259`
- Modify: `tests/unit/daemon/profile-args.test.ts:27-42`

- [ ] **Step 1: Add service-definition safety assertions against key names and secret values**

Modify `tests/unit/daemon/profile-args.test.ts` in the `pins launchd, systemd, and schtasks launch commands to run --profile` test.

Before building service text, temporarily set representative provider key values in `process.env`:

```ts
    const oldZai = process.env.ZAI_CODING_CN_API_KEY;
    const oldOpenai = process.env.OPENAI_API_KEY;
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.ZAI_CODING_CN_API_KEY = 'zai-secret-value-that-must-not-leak';
    process.env.OPENAI_API_KEY = 'openai-secret-value-that-must-not-leak';
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret-value-that-must-not-leak';
    try {
      const allServiceText = [buildPlist(inputs), buildUnit(inputs), buildLauncherCmd(inputs)].join('\n');
      expect(allServiceText).not.toContain('ZAI_CODING_CN_API_KEY');
      expect(allServiceText).not.toContain('OPENAI_API_KEY');
      expect(allServiceText).not.toContain('ANTHROPIC_API_KEY');
      expect(allServiceText).not.toContain('zai-secret-value-that-must-not-leak');
      expect(allServiceText).not.toContain('openai-secret-value-that-must-not-leak');
      expect(allServiceText).not.toContain('anthropic-secret-value-that-must-not-leak');
    } finally {
      if (oldZai === undefined) delete process.env.ZAI_CODING_CN_API_KEY;
      else process.env.ZAI_CODING_CN_API_KEY = oldZai;
      if (oldOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenai;
      if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldAnthropic;
    }
```

This checks full rendered launchd/systemd/Windows service text against both environment variable names and actual representative secret values.

- [ ] **Step 2: Run service tests**

Run:

```bash
pnpm vitest run tests/unit/daemon/profile-args.test.ts
```

Expected: PASS. This locks in the no-secret-in-service-file invariant.

- [ ] **Step 3: Add env file location hint after daemon dispatch**

Modify `src/cli/commands/service.ts` in `reportConnectAfter()`, after the successful connection log and before `return`, add a compact note:

```ts
    console.log('  daemon env: ~/.lark-channel/daemon.env 或 ~/.lark-channel/profiles/<profile>/daemon.env');
```

Replace `<profile>` with the actual profile for clarity:

```ts
    console.log(`  daemon env: ~/.lark-channel/daemon.env 或 ~/.lark-channel/profiles/${profile}/daemon.env`);
```

Also add the same hint to the timeout warning block after the log paths:

```ts
  console.warn(`  daemon env: ~/.lark-channel/daemon.env 或 ~/.lark-channel/profiles/${profile}/daemon.env`);
```

Keep this as discoverability only; do not create or edit env files.

- [ ] **Step 4: Run service tests and typecheck**

Run:

```bash
pnpm vitest run tests/unit/daemon/profile-args.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit service UX**

```bash
git add src/cli/commands/service.ts tests/unit/daemon/profile-args.test.ts
git commit -m "chore: document daemon env locations in service output"
```

---

### Task 4: Document daemon env files

**Files:**
- Modify: `README.md:89-91`
- Modify: `README.zh.md:89-91`

- [ ] **Step 1: Add English documentation**

In `README.md`, after the daemon logs paragraph, add:

````md
Daemon services do not inherit arbitrary variables from the shell that ran `start`. For provider API keys or proxy settings needed by daemon-mode agents, create daemon env files:

```env
# ~/.lark-channel/daemon.env              # shared by all profiles
# ~/.lark-channel/profiles/<profile>/daemon.env  # overrides per profile
ZAI_CODING_CN_API_KEY=xxx
HTTPS_PROXY=http://127.0.0.1:7890
```

Restart the service after editing these files. Env files only provide credentials/settings; they do not select the provider or model. If multiple provider keys are present, the underlying agent CLI and the profile model preference still decide what to use.
````

- [ ] **Step 2: Add Chinese documentation**

In `README.zh.md`, after the daemon logs paragraph, add:

````md
daemon 服务不会继承执行 `start` 时 shell 里的任意环境变量。如果后台 agent/provider 需要 API key 或代理配置，请写入 daemon env 文件：

```env
# ~/.lark-channel/daemon.env                    # 所有 profile 共享
# ~/.lark-channel/profiles/<profile>/daemon.env # profile 级覆盖
ZAI_CODING_CN_API_KEY=xxx
HTTPS_PROXY=http://127.0.0.1:7890
```

修改后需要重启服务。env 文件只提供凭据和环境配置，不负责选择 provider 或模型；如果同时存在多个 provider key，实际使用哪个 provider/model 仍由底层 agent CLI 和 profile 的模型偏好决定。
````

- [ ] **Step 3: Run docs-adjacent verification**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit docs**

```bash
git add README.md README.zh.md
git commit -m "docs: explain daemon env files"
```

---

### Task 5: Final verification

**Files:**
- Verify whole repository

- [ ] **Step 1: Run full unit/process/integration test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Inspect generated service text invariants**

Run:

```bash
pnpm vitest run tests/unit/daemon/profile-args.test.ts tests/unit/daemon/env-file.test.ts
```

Expected: PASS, including assertions that service definitions do not contain provider key names.

- [ ] **Step 5: Commit any final fixes**

If verification required fixes:

```bash
git add <changed-files>
git commit -m "fix: stabilize daemon env file support"
```

If no fixes were needed, do not create an empty commit.
