import { describe, expect, it } from 'vitest';
import { buildPlist } from '../../../src/daemon/launchd';
import {
  daemonStderrPath,
  daemonStdoutPath,
  launchAgentLabel,
  serviceProfileId,
  systemdUnitName,
  windowsTaskName,
} from '../../../src/daemon/paths';
import { buildLauncherCmd } from '../../../src/daemon/schtasks';
import { buildUnit } from '../../../src/daemon/systemd';

describe('profile-scoped daemon paths and arguments', () => {
  it('sanitizes service ids and gives each profile distinct service names and logs', () => {
    expect(() => serviceProfileId('codex dev')).toThrow(/invalid profile name/i);
    expect(serviceProfileId('codex_dev')).toBe('codex_dev');
    expect(launchAgentLabel('codex-dev')).toContain('codex-dev');
    expect(systemdUnitName('claude')).not.toBe(systemdUnitName('codex-dev'));
    expect(windowsTaskName('claude')).not.toBe(windowsTaskName('codex-dev'));
    expect(daemonStdoutPath('claude')).not.toBe(daemonStdoutPath('codex-dev'));
    expect(daemonStderrPath('codex-dev').replace(/\\/g, '/')).toContain(
      '/profiles/codex-dev/logs/daemon/',
    );
  });

  it('pins launchd, systemd, and schtasks launch commands to run --profile', () => {
    const inputs = {
      nodePath: '/usr/local/bin/node',
      bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
      envPath: '/usr/local/bin:/usr/bin',
      profile: 'codex-dev',
      channelHome: '/tmp/lark-channel-home',
    };

    expect(buildPlist(inputs)).toContain('<string>--profile</string>\n        <string>codex-dev</string>');
    expect(buildPlist(inputs)).toContain('<key>LARK_CHANNEL_HOME</key>\n        <string>/tmp/lark-channel-home</string>');
    expect(buildUnit(inputs)).toContain('run --profile "codex-dev"');
    expect(buildUnit(inputs)).toContain('Environment="LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
    expect(buildLauncherCmd(inputs)).toContain('run --profile "codex-dev"');
    expect(buildLauncherCmd(inputs)).toContain('set "LARK_CHANNEL_HOME=/tmp/lark-channel-home"');

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
  });
});
