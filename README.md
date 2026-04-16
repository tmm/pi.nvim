# pi.nvim

Thin Neovim bridge for [Pi](https://pi.dev).

## What it does

- exposes current Neovim file to `pi`
- exposes current visual selection to `pi`
- exposes current diagnostics and editor metadata to `pi`
- shows lightweight Neovim connection status in `pi`
- auto-installs required `pi` extension into `~/.pi/agent/extensions/`

## Install with lazy.nvim

```lua
{
  "tmm/pi.nvim",
  lazy = false,
  opts = {
    auto_start = true,                 -- start nvim bridge automatically on setup
    auto_install_pi_extension = true,  -- install/update pi-side extension automatically
    debounce_ms = 100,                 -- debounce bridge refreshes from cursor/edit/mode events
    notify_on_install = true,          -- show notification when pi extension is installed
  },
}
```

Then restart Neovim and run `/reload` in `pi`.

## Usage

Inside `pi`, you can use:

- `@nvim:current`
- `@nvim:selection`
- `@nvim:diagnostics`
- `@nvim:context`

Examples:

```text
Explain @nvim:selection
Fix @nvim:current using @nvim:diagnostics
```

You do not always need to reference these explicitly. If the bridge is active, `pi` can often answer natural questions like:

```text
What file do I have open?
What do I have selected?
```

by querying Neovim automatically.

## Commands

### Neovim

- `:PiAsk` opens an input prompt in Neovim and sends the message to the active `pi` session for the current project
- `:PiCopyRef` copies `@nvim:current`, or `@nvim:selection` when used with a visual selection
- `:PiDisable` disables the pi.nvim bridge
- `:PiEnable` enables the pi.nvim bridge
- `:PiFollowUp` queues a follow-up message for Pi
- `:PiInstallExtension` installs the pi.nvim extension for Pi
- `:PiRefresh` refreshes the current pi.nvim bridge context
- `:PiSteer` sends a steering message to Pi
- `:PiStatus` shows the current pi.nvim bridge status

When run from visual mode, `:PiAsk`, `:PiSteer`, and `:PiFollowUp` accept the selection and automatically add `@nvim:selection` to the message.

You can also pass the message directly:

```vim
:PiAsk Explain @nvim:selection
:PiSteer Use @nvim:selection instead of the whole file
:PiFollowUp After that, add tests

" from visual mode, this will send: "explain this @nvim:selection"
:'<,'>PiAsk explain this
```

### pi

- `/nvim-status` shows the current pi.nvim bridge lockfile and active file summary
- `/nvim-switch` switches to a different running Neovim bridge instance

## Development

```bash
pnpm install
pnpm check
pnpm check:types
pnpm check:fix
pnpm staged
pnpm test
```

This uses [Vite+](https://viteplus.dev/) for formatting, linting, staged-file checks, and TypeScript Go powered type checking via `vp check`.

## License

MIT
