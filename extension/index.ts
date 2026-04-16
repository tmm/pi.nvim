import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { Type } from '@mariozechner/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'

export default function nvimBridgeExtension(pi: ExtensionAPI) {
  let widgetTimer: ReturnType<typeof setInterval> | undefined
  let selectedLockfilePath: string | undefined
  let disconnectedAt: number | undefined
  let hadConnection = false
  let promptServer: net.Server | undefined
  let promptLockfilePath: string | undefined

  const stopPromptServer = async () => {
    const lockfilePath = promptLockfilePath
    promptLockfilePath = undefined

    if (lockfilePath) {
      await fs.unlink(lockfilePath).catch(() => undefined)
    }

    if (!promptServer) return

    const server = promptServer
    promptServer = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const startPromptServer = async (ctx: ExtensionContext) => {
    await stopPromptServer()

    const token = crypto.randomBytes(24).toString('hex')
    const server = net.createServer((socket) => {
      let raw = ''
      let responded = false

      const respond = (response: {
        ok: boolean
        error?: string
        deliverAs?: 'steer' | 'followUp' | 'direct'
      }) => {
        if (responded) return
        responded = true
        socket.end(JSON.stringify(response) + '\n')
      }

      socket.setTimeout(2000)
      socket.on('timeout', () => respond({ ok: false, error: 'Timed out waiting for request' }))
      socket.on('data', (chunk) => {
        raw += chunk.toString('utf8')
        if (!raw.includes('\n')) return

        try {
          const request = JSON.parse(raw.split('\n')[0]!.trim()) as {
            token: string
            message: string
            deliverAs?: 'steer' | 'followUp'
          }
          if (request.token !== token) {
            respond({ ok: false, error: 'unauthorized' })
            return
          }

          const message = request.message?.trim()
          if (!message) {
            respond({ ok: false, error: 'Message must not be empty' })
            return
          }

          const deliverAs = request.deliverAs || (ctx.isIdle() ? undefined : 'steer')
          if (deliverAs) {
            pi.sendUserMessage(message, { deliverAs })
            respond({ ok: true, deliverAs })
          } else {
            pi.sendUserMessage(message)
            respond({ ok: true, deliverAs: 'direct' })
          }
        } catch (error) {
          respond({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
      socket.on('error', () => {
        socket.destroy()
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('Failed to bind pi prompt server')
    }

    const bridgeDir = getProjectBridgeDir(ctx.cwd)
    const lockfilePath = getPromptLockfilePath(ctx.cwd)
    await fs.mkdir(bridgeDir, { recursive: true })
    await fs.writeFile(
      lockfilePath,
      JSON.stringify({
        host: '127.0.0.1',
        port: address.port,
        token,
        project_root: ctx.cwd,
        bridge_dir: bridgeDir,
        pid: process.pid,
        updated_at: new Date().toISOString(),
      } satisfies {
        host: string
        port: number
        token: string
        project_root?: string
        bridge_dir?: string
        pid?: number
        updated_at?: string
      }),
    )

    promptServer = server
    promptLockfilePath = lockfilePath
  }

  const startStatus = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return

    const update = async () => {
      try {
        const lockfilePath = await findLockfile(ctx.cwd, selectedLockfilePath)
        if (!lockfilePath) {
          hadConnection = false
          disconnectedAt = undefined
          ctx.ui.setStatus('nvim-bridge', undefined)
          return
        }

        const lockfile = await readJson<Lockfile>(lockfilePath)
        const response = await queryBridge(lockfile, 'context')
        hadConnection = true
        disconnectedAt = undefined
        ctx.ui.setStatus('nvim-bridge', renderStatusLine(ctx.ui.theme, response))
      } catch {
        if (!hadConnection) {
          ctx.ui.setStatus('nvim-bridge', undefined)
          return
        }
        disconnectedAt = disconnectedAt || Date.now()
        if (Date.now() - disconnectedAt <= 5000) {
          ctx.ui.setStatus('nvim-bridge', renderStatusLine(ctx.ui.theme, undefined))
        } else {
          ctx.ui.setStatus('nvim-bridge', undefined)
        }
      }
    }

    const scheduleUpdate = () => {
      widgetTimer = setTimeout(async () => {
        await update()
        if (widgetTimer) {
          scheduleUpdate()
        }
      }, 400)
    }

    await update()
    if (widgetTimer) clearInterval(widgetTimer)
    scheduleUpdate()
  }

  const stopStatus = (ctx?: ExtensionContext) => {
    if (widgetTimer) {
      clearInterval(widgetTimer)
      widgetTimer = undefined
    }
    ctx?.ui.setStatus('nvim-bridge', undefined)
  }

  pi.registerTool({
    name: 'nvim_bridge',
    label: 'Neovim Bridge',
    description:
      'Read editor context from a running pi.nvim bridge server. Supports @nvim:current, @nvim:selection, @nvim:diagnostics, and @nvim:context references.',
    promptSnippet:
      'Read the current Neovim file, selection, diagnostics, or bridge context via pi.nvim refs like @nvim:current and @nvim:selection.',
    promptGuidelines: [
      'When the user mentions @nvim:current, call nvim_bridge with target=current.',
      'When the user mentions @nvim:selection, call nvim_bridge with target=selection.',
      'When the user mentions @nvim:diagnostics, call nvim_bridge with target=diagnostics.',
      'Use this tool instead of asking the user to paste their current editor contents.',
    ],
    parameters: Type.Object({
      target: Type.Union(
        TARGETS.map((target) => Type.Literal(target)),
        {
          description: 'Which Neovim bridge payload to read',
        },
      ),
    }),
    renderCall(args, theme) {
      return textComponent(
        theme.fg('toolTitle', theme.bold('nvim_bridge ')) + theme.fg('accent', args.target),
      )
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as {
        lockfilePath?: string
        bridgeDir?: string
        bridgeBaseDir?: string
        target?: Target
        context?: BridgeContext
        error?: string
      }

      if (isPartial) {
        return textComponent(theme.fg('warning', 'Querying Neovim…'))
      }

      if (details?.error) {
        let text = theme.fg('error', summarizeBridgeResult(details || {}))
        if (!expanded) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
        if (expanded) {
          const content = result.content[0]
          if (content?.type === 'text') text += `\n\n${theme.fg('dim', content.text)}`
        }
        return textComponent(text)
      }

      let text = theme.fg('success', summarizeBridgeResult(details || {}))
      if (!expanded) {
        text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
        return textComponent(text)
      }

      const extra = [] as string[]
      if (details?.lockfilePath) extra.push(`lockfile: ${details.lockfilePath}`)
      if (details?.bridgeDir) extra.push(`bridge_dir: ${details.bridgeDir}`)
      const content = result.content[0]
      if (content?.type === 'text') extra.push('', content.text)
      if (extra.length > 0) text += `\n${theme.fg('dim', extra.join('\n'))}`
      return textComponent(text)
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const lockfilePath = await findLockfile(ctx.cwd, selectedLockfilePath)
        if (!lockfilePath) {
          throw new Error(`No pi.nvim bridge lockfile found under ${getBridgeBaseDir()}`)
        }

        const lockfile = await readJson<Lockfile>(lockfilePath)
        const response = await queryBridge(lockfile, params.target as Target)
        if (!response.ok) {
          throw new Error(response.error || 'Bridge request failed')
        }

        let text: string
        if (params.target === 'context') {
          text = formatContext(response.context)
        } else if (params.target === 'current') {
          text = [
            `# Neovim current file`,
            formatContext(response.context),
            '',
            response.text || '',
          ].join('\n')
        } else if (params.target === 'selection') {
          text = [
            `# Neovim selection`,
            formatContext(response.context),
            '',
            response.text || '(no selection)',
          ].join('\n')
        } else if (params.target === 'diagnostics') {
          text = [
            `# Neovim diagnostics`,
            formatContext(response.context),
            '',
            JSON.stringify(response.diagnostics || [], null, 2),
          ].join('\n')
        } else {
          text = [
            `# Neovim bridge`,
            formatContext(response.context),
            '',
            '## Selection',
            response.selection || '(no selection)',
            '',
            '## Diagnostics',
            JSON.stringify(response.diagnostics || [], null, 2),
            '',
            '## Buffer',
            response.text || '',
          ].join('\n')
        }

        return {
          content: [{ type: 'text', text }],
          details: {
            lockfilePath,
            bridgeDir: lockfile.bridge_dir,
            target: params.target as Target,
            context: response.context,
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text', text: `Could not query pi.nvim bridge. ${message}` }],
          details: {
            bridgeBaseDir: getBridgeBaseDir(),
            target: params.target as Target,
            error: message,
          },
          isError: true,
        }
      }
    },
  })

  pi.registerCommand('nvim-status', {
    description: 'Show the current pi.nvim bridge lockfile',
    handler: async (_args, ctx) => {
      const lockfilePath = await findLockfile(ctx.cwd, selectedLockfilePath)
      if (!lockfilePath) {
        ctx.ui.notify('pi.nvim bridge: not found', 'warning')
        return
      }

      const lockfile = await readJson<Lockfile>(lockfilePath)
      const response = await queryBridge(lockfile, 'context').catch(() => undefined)
      const context = response?.context
      const file = context?.relative_path || context?.file
      const summary = file
        ? `${formatPathForDisplay(file)}${formatLocationSummary(context)}`
        : `nvim ${context?.nvim?.version || '0.11.5'}`

      ctx.ui.notify(
        `pi.nvim bridge\nlockfile: ${formatPathForDisplay(lockfilePath)}\nmode: ${selectedLockfilePath ? 'manual' : 'auto'}\ncurrent: ${summary}`,
        'info',
      )
    },
  })

  pi.registerCommand('nvim-switch', {
    description: 'Switch to a different running Neovim bridge instance',
    handler: async (_args, ctx) => {
      const candidates = await listLockfiles()
      if (candidates.length === 0) {
        ctx.ui.notify('No running nvim bridge instances found', 'warning')
        return
      }

      const candidateSummaries = await Promise.all(
        candidates.map(async (candidate) => {
          const root = formatPathForDisplay(candidate.lockfile.project_root || '(unknown root)')
          const response = await queryBridge(candidate.lockfile, 'context').catch(() => undefined)
          const context = response?.context
          const file = context?.relative_path || context?.file
          if (file) {
            return `${root} • ${formatPathForDisplay(file)}`
          }
          return root
        }),
      )

      const autoLockfilePath = await findLockfile(ctx.cwd)
      const autoIndex = autoLockfilePath
        ? candidates.findIndex((candidate) => candidate.path === autoLockfilePath)
        : -1
      const autoLabel =
        autoIndex >= 0 ? `Auto (${candidateSummaries[autoIndex]})` : 'Auto (match current cwd)'

      const items = [autoLabel, ...candidateSummaries]

      const choice = await ctx.ui.select('Select Neovim instance', items)
      if (!choice) return

      if (choice === items[0]) {
        selectedLockfilePath = undefined
        ctx.ui.notify('Neovim bridge selection reset to auto', 'info')
      } else {
        const index = items.indexOf(choice) - 1
        selectedLockfilePath = candidates[index]?.path
        const selected = candidates[index]
        const response = selected
          ? await queryBridge(selected.lockfile, 'context').catch(() => undefined)
          : undefined
        const file = response?.context?.relative_path || response?.context?.file
        const summary = file
          ? `${formatPathForDisplay(file)}${formatLocationSummary(response?.context)}`
          : formatPathForDisplay(selected?.lockfile.project_root || selectedLockfilePath || '')
        ctx.ui.notify(`Neovim bridge switched: ${summary}`, 'info')
      }

      await startStatus(ctx)
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    await startStatus(ctx)
    await startPromptServer(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    stopStatus(ctx)
    await stopPromptServer()
  })
}

const TARGETS = ['current', 'selection', 'diagnostics', 'context', 'all'] as const

type Target = (typeof TARGETS)[number]

type BridgeContext = {
  project_root?: string
  file?: string
  relative_path?: string
  filetype?: string
  modified?: boolean
  cursor?: { line?: number; col?: number }
  selection?: {
    active?: boolean
    start?: { line?: number; col?: number }
    end?: { line?: number; col?: number }
  }
  diagnostics_count?: number
  updated_at?: string
  nvim?: {
    pid?: number
    servername?: string
    version?: string
  }
}

type Lockfile = {
  host: string
  port: number
  token: string
  project_root?: string
  bridge_dir?: string
  pid?: number
  updated_at?: string
}

type BridgeResponse = {
  ok: boolean
  error?: string
  target?: Target
  context?: BridgeContext
  text?: string
  selection?: string
  diagnostics?: unknown
}

function getBridgeBaseDir() {
  return process.env.PI_NVIM_BRIDGE_DIR || path.join(os.homedir(), '.cache', 'nvim', 'pi-bridge')
}

function projectRootId(root: string) {
  const name = path.basename(root).replace(/[^\w\-_]/g, '-')
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)
  return `${name}-${hash}`
}

function getProjectBridgeDir(cwd: string) {
  return path.join(getBridgeBaseDir(), projectRootId(cwd))
}

function getPromptLockfilePath(cwd: string) {
  return path.join(getProjectBridgeDir(cwd), 'pi-session.json')
}

async function readJson<type>(path: string): Promise<type> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as type
}

async function listLockfiles() {
  const baseDir = getBridgeBaseDir()
  const candidates = [] as Array<{ path: string; lockfile: Lockfile }>
  const directPath = path.join(baseDir, 'lock.json')
  const directLockfile = await readJson<Lockfile>(directPath).catch(() => undefined)
  if (directLockfile) {
    candidates.push({ path: directPath, lockfile: directLockfile })
  }

  const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const lockfilePath = path.join(baseDir, entry.name, 'lock.json')
    const lockfile = await readJson<Lockfile>(lockfilePath).catch(() => undefined)
    if (!lockfile?.project_root) continue
    candidates.push({ path: lockfilePath, lockfile })
  }

  return candidates
}

async function findLockfile(cwd: string, preferredPath?: string) {
  const candidates = await listLockfiles()

  if (preferredPath) {
    const preferred = candidates.find((candidate) => candidate.path === preferredPath)
    return preferred?.path
  }

  const matches = candidates
    .filter(
      ({ lockfile }) =>
        cwd === lockfile.project_root || cwd.startsWith(lockfile.project_root + '/'),
    )
    .sort(
      (a, b) =>
        (b.lockfile.project_root?.length || 0) - (a.lockfile.project_root?.length || 0) ||
        (b.lockfile.updated_at || '').localeCompare(a.lockfile.updated_at || ''),
    )

  return matches[0]?.path
}

function formatContext(context: BridgeContext | undefined) {
  if (!context) return '(no context)'
  return [
    `file: ${context.relative_path || context.file || '(none)'}`,
    `filetype: ${context.filetype || '(none)'}`,
    `modified: ${context.modified ? 'yes' : 'no'}`,
    `cursor: ${context.cursor?.line ?? 0}:${context.cursor?.col ?? 0}`,
    `selection_active: ${context.selection?.active ? 'yes' : 'no'}`,
    `diagnostics: ${context.diagnostics_count ?? 0}`,
    `updated_at: ${context.updated_at || '(unknown)'}`,
  ].join('\n')
}

async function queryBridge(lockfile: Lockfile, target: Target): Promise<BridgeResponse> {
  return await new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let raw = ''
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      socket.destroy()
      fn()
    }

    socket.setTimeout(2000)
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8')
    })
    socket.on('timeout', () =>
      finish(() => reject(new Error('Timed out connecting to Neovim bridge'))),
    )
    socket.on('error', (error) => finish(() => reject(error)))
    socket.on('close', () => {
      if (settled) return
      finish(() => {
        try {
          resolve(JSON.parse(raw.trim()) as BridgeResponse)
        } catch (error) {
          reject(error)
        }
      })
    })
    socket.connect(lockfile.port, lockfile.host, () => {
      socket.end(`${JSON.stringify({ token: lockfile.token, target })}\n`)
    })
  })
}

function selectedLineRange(context: BridgeContext | undefined) {
  if (!context?.selection?.active) return undefined

  const start = context.selection.start?.line
  const end = context.selection.end?.line
  if (start == null || end == null) return undefined
  if (start === end) return `L${start}`
  return `L${start}-${end}`
}

function formatPathForDisplay(path: string) {
  const home = os.homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function formatLocationSummary(context: BridgeContext | undefined) {
  const lineRange = selectedLineRange(context)
  if (lineRange) return `  ${lineRange}`

  const line = context?.cursor?.line
  if (line != null) return `  L${line}`

  return ''
}

function textComponent(text: string) {
  return {
    render(width: number) {
      return text.split('\n').flatMap((line) => {
        if (width <= 0 || line.length <= width) return [line]
        const parts = [] as string[]
        for (let i = 0; i < line.length; i += width) parts.push(line.slice(i, i + width))
        return parts
      })
    },
    invalidate() {},
  }
}

function summarizeBridgeResult(details: {
  target?: Target
  context?: BridgeContext
  error?: string
}) {
  if (details.error) return `Error: ${details.error}`

  const target = details.target || 'context'
  const context = details.context
  const file = context?.relative_path || context?.file || '(no file)'
  const basename = file.split('/').pop() || file
  const location = formatLocationSummary(context)
  const diagnostics = context?.diagnostics_count ?? 0

  if (target === 'diagnostics') return `${basename}${location}  ${diagnostics} diag`
  if (target === 'selection') return `${basename}${location}  sel`
  if (target === 'all') return `${basename}${location}  ${diagnostics} diag`
  return `${basename}${location}`
}

function renderStatusLine(
  theme: Pick<ExtensionContext['ui']['theme'], 'fg'>,
  response?: BridgeResponse,
) {
  const version = response?.context?.nvim?.version || '0.11.5'
  if (!response?.ok || !response.context) {
    return theme.fg('warning', 'Reconnecting') + theme.fg('dim', ` to nvim ${version}`)
  }

  const prefix = theme.fg('dim', '✓ ')
  const file = response.context.relative_path || response.context.file
  if (!file) {
    return prefix + theme.fg('dim', `nvim ${version}`)
  }

  const basename = file.split('/').pop() || file
  const lineRange = selectedLineRange(response.context)
  if (lineRange) {
    return prefix + theme.fg('dim', `${basename} • ${lineRange}`)
  }

  return prefix + theme.fg('dim', basename)
}
