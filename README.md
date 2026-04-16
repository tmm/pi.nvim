# pi.nvim

Thin Neovim bridge for [Pi](https://pi.dev).

## What it does

- exposes the current Neovim file to `pi`
- exposes the current visual selection to `pi`
- exposes current diagnostics and editor metadata to `pi`
- shows lightweight Neovim connection status inside `pi`
- auto-installs the required `pi` extension into `~/.pi/agent/extensions/`

## Install with lazy.nvim

```lua
{
  "tmm/pi.nvim",
  lazy = false,
  opts = {
    auto_start = true,
    auto_install_pi_extension = true,
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

- `:PiBridgeEnable`
- `:PiBridgeDisable`
- `:PiBridgeStatus`
- `:PiBridgeCopyRef`
- `:PiBridgeInstallExtension`

### pi

- `/nvim-status`
- `/nvim-switch`

## Development

```bash
pnpm install
pnpm check
pnpm check:fix
pnpm staged
pnpm test
```

This uses [Vite+](https://viteplus.dev/) for formatting, linting, staged-file checks, and TypeScript Go powered type checking via `vp check`.

## License

MIT
