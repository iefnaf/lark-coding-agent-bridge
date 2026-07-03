# Daemon Env File Design

## Problem

When `lark-channel-bridge` runs in daemon mode, the operating system service manager starts the bridge with a minimal environment. The current service definitions explicitly preserve only `PATH` and `LARK_CHANNEL_HOME`.

As a result, provider credentials exported in the user's interactive shell, such as `ZAI_CODING_CN_API_KEY`, are not available to the daemon process. Agent child processes inherit the daemon's `process.env`, so the missing variables also do not reach providers used by Pi or other agent CLIs.

## Goals

- Let daemon-mode runs receive provider API keys and other user-configured environment variables.
- Avoid writing secrets directly into launchd plists, systemd units, or Windows task launcher commands.
- Support global defaults and per-profile overrides.
- Keep provider and model selection explicit; do not infer model/provider from available keys.
- Keep behavior consistent across macOS, Linux, and Windows.

## Non-goals

- Do not inherit the entire shell environment by default.
- Do not add automatic provider routing based on which API keys exist.
- Do not add a full env management CLI in this change.
- Do not implement shell-compatible parsing or command substitution.

## Design

The bridge will load daemon-specific dotenv files during the `run --profile <profile>` startup path, before runtime configuration, provider resolution, or agent spawning.

Two files are supported:

```text
~/.lark-channel/daemon.env
~/.lark-channel/profiles/<profile>/daemon.env
```

Loading order:

1. Existing daemon process environment
2. Global `daemon.env`
3. Profile `daemon.env`

Later sources override earlier ones. This means a profile-level variable overrides the global value, and env-file values override variables already present in the daemon process.

After parsing and merging, values are applied to `process.env`. Existing agent spawn code already passes `process.env` to child processes, so provider CLIs inherit the loaded variables naturally.

The service definitions remain minimal. They should continue to include only operational variables such as `PATH` and `LARK_CHANNEL_HOME`; provider secrets should not be serialized into plist/unit/cmd files.

## Env File Format

Use a small dotenv subset:

```env
# comments are allowed
ZAI_CODING_CN_API_KEY=xxx
OPENAI_API_KEY="yyy"
ANTHROPIC_API_KEY='zzz'
HTTPS_PROXY=http://127.0.0.1:7890
export EXTRA_VAR=value
EMPTY_VALUE=
```

Supported syntax:

- Blank lines
- Full-line comments beginning with `#`
- `KEY=VALUE`
- Optional `export KEY=VALUE`
- Single-quoted values
- Double-quoted values
- Empty values
- Whitespace around keys and values

Unsupported syntax:

- Shell expansion, such as `FOO=$BAR`
- Command substitution
- Multiline values
- Inline comment parsing inside values
- Arbitrary shell syntax

## Provider and Model Selection Boundary

Daemon env files only provide environment variables. They do not choose providers or models.

For example, if a file contains:

```env
ZAI_CODING_CN_API_KEY=xxx
OPENAI_API_KEY=yyy
ANTHROPIC_API_KEY=zzz
```

bridge will not infer that ZAI, OpenAI, or Anthropic should be used. It only makes these variables available to the running daemon and its child processes.

Model selection continues to follow existing behavior:

- If profile `preferences.model` is unset or `default`, bridge omits `--model`.
- The underlying agent CLI then chooses its own default model.
- If the user explicitly selects a model through existing configuration UI, bridge passes `--model <model>`.
- Provider selection remains the responsibility of the underlying agent CLI or its own configuration. For Pi, Pi's provider/model configuration remains authoritative.

## Error Handling

Missing env files are ignored.

Malformed lines are skipped and logged as warnings. Warnings must include the file path and line number but must not print secret values.

Duplicate keys are allowed. The later value wins:

- Later line in the same file overrides earlier line.
- Profile file overrides global file.

Values are never printed in logs.

## User Experience

`start` and `restart` flows should make the env file locations discoverable. The success or diagnostic text should mention that daemon-specific provider keys belong in:

```text
~/.lark-channel/daemon.env
~/.lark-channel/profiles/<profile>/daemon.env
```

Documentation should explain:

- Interactive shell exports are not inherited by daemon services.
- Put provider API keys in daemon env files for daemon mode.
- Restart the daemon after editing env files.
- Env files provide credentials only; they do not choose provider/model.

## Testing

Unit tests should cover the parser:

- Blank lines and comments
- `KEY=VALUE`
- Single-quoted values
- Double-quoted values
- `export KEY=VALUE`
- Empty values
- Invalid lines are skipped with warnings
- Duplicate keys use the last value

Merge tests should cover:

- Global env loading
- Profile env overriding global env
- Env files overriding existing `process.env`
- Missing files being ignored

Integration-level tests should cover:

- The env loader runs early in `run --profile <profile>` before runtime/provider/agent setup.
- Loaded variables are visible in `process.env` before agent spawn.
- Generated launchd/systemd/Windows service definitions do not contain provider API key values.

## Acceptance Criteria

- A user can put `ZAI_CODING_CN_API_KEY=...` in `~/.lark-channel/profiles/<profile>/daemon.env` and have daemon-mode provider calls read it.
- A profile env file can override a global env file value.
- Editing env files takes effect after `lark-channel-bridge restart --profile <profile>`.
- The daemon does not automatically inherit every variable from the shell that ran `start`.
- The presence of multiple provider keys does not change provider/model selection logic.
