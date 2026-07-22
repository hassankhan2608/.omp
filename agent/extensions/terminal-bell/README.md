# OMP Terminal Bell

A standalone OMP extension that ports the notification behavior from `~/.opencode/plugin/terminal-bell` without coupling it to `bash-policy`.

## Behavior

| OMP signal | Config key | Default sound |
|---|---|---|
| A visible agent run settles successfully | `agent.complete` | `complete.oga` |
| OMP opens a tool approval prompt | `approval.requested` | `minecraft_item_drop.mp3` |
| A visible agent run settles with `stopReason: "error"` | `agent.error` | `message.oga` |

Completion uses OMP's `agent_end` event because it runs after the main-session stop hooks and exposes `willContinue`. Automatic continuations do not ring early. Aborted runs and headless subagents are intentionally silent.

Notifications share one debounce window. Audio playback is detached and advisory: a missing audio player never interrupts OMP. Linux uses `paplay`, macOS uses `afplay`, and Windows uses PowerShell `Media.SoundPlayer`.

## Layout

```text
terminal-bell/
├── src/
│   ├── index.ts       # OMP event bindings
│   ├── config.ts      # strict config loading and defaults
│   └── notifier.ts    # playback, terminal focus, and debounce
├── tests/
│   └── terminal-bell.test.ts
├── sounds/
├── config.json
├── config.schema.json
├── package.json
├── bun.lock
├── tsconfig.json
└── README.md
```

## Configuration

Edit `config.json`:

```json
{
  "$schema": "./config.schema.json",
  "enabled": true,
  "debounceMs": 500,
  "focusTerminal": false,
  "sounds": {
    "complete": { "enabled": true, "file": "complete.oga" },
    "input": { "enabled": true, "file": "minecraft_item_drop.mp3" },
    "error": { "enabled": true, "file": "message.oga" }
  },
  "events": {
    "agent.complete": "complete",
    "approval.requested": "input",
    "agent.error": "error"
  }
}
```

Relative sound names resolve under `sounds/`. Absolute Unix and Windows paths are also accepted. Set `focusTerminal` to `true` to write ASCII BEL (`\x07`) after dispatching a sound.

Restart OMP after changing extension code or configuration.

## Development

```bash
bun test
bun x tsc --noEmit
bun build src/index.ts --outdir=/tmp/omp-terminal-bell-build --target=bun
```
