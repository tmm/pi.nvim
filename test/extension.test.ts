import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { expect, test, vi } from 'vitest'

import extension from '../extension/index.js'

type RegisteredCommand = {
  name: string
  description?: string
  handler: (args: string, ctx: any) => Promise<void> | void
}

type RegisteredTool = {
  name: string
  description?: string
  execute: (...args: any[]) => any
}

function loadExtension() {
  const commands: RegisteredCommand[] = []
  const tools: RegisteredTool[] = []
  const sessionStartHandlers: Array<(event: any, ctx: any) => Promise<void> | void> = []
  const sessionShutdownHandlers: Array<(event: any, ctx: any) => Promise<void> | void> = []

  extension({
    on(event: any, handler: any) {
      if (event === 'session_start') sessionStartHandlers.push(handler)
      if (event === 'session_shutdown') sessionShutdownHandlers.push(handler)
    },
    registerCommand(name: string, options: any) {
      commands.push({ name, description: options.description, handler: options.handler })
    },
    registerTool(definition: any) {
      tools.push({
        name: definition.name,
        description: definition.description,
        execute: definition.execute,
      })
    },
  } as ExtensionAPI)

  return { commands, tools, sessionStartHandlers, sessionShutdownHandlers }
}

async function startBridgeServer(responseFactory: (target: string) => any) {
  const server = net.createServer((socket) => {
    let raw = ''
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8')
      if (!raw.includes('\n')) return
      const line = raw.split('\n')[0]!
      const request = JSON.parse(line) as { token: string; target: string }
      socket.end(JSON.stringify(responseFactory(request.target)) + '\n')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind test server')

  return {
    host: '127.0.0.1',
    port: address.port,
    stop: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

function makeUi() {
  return {
    notify: vi.fn(),
    select: vi.fn(),
    setStatus: vi.fn(),
    theme: { fg: (_c: string, text: string) => text },
  }
}

test('registers nvim bridge tool and commands', () => {
  const { commands, tools } = loadExtension()

  expect(commands.map((command) => command.name)).toEqual(['nvim-status', 'nvim-switch'])
  expect(tools.map((tool) => tool.name)).toEqual(['nvim_bridge'])
})

test('nvim-status shows lockfile, mode, and current file summary', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nvim-ext-status-'))
  vi.stubEnv('PI_NVIM_BRIDGE_DIR', tmpDir)

  const bridge = await startBridgeServer((target) => ({
    ok: true,
    target,
    context: {
      relative_path: 'nvim/lua/plugins.lua',
      cursor: { line: 14, col: 7 },
      nvim: { version: '0.11.5' },
      selection: { active: false },
    },
  }))

  const lockfilePath = path.join(tmpDir, 'lock.json')
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({ host: bridge.host, port: bridge.port, token: 'test', project_root: '/repo' }),
  )

  const notify = vi.fn()
  const { commands } = loadExtension()
  const command = commands.find((entry) => entry.name === 'nvim-status')

  await command!.handler('', {
    cwd: '/repo',
    ui: { notify },
  })

  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining('current: nvim/lua/plugins.lua • L14'),
    'info',
  )

  await bridge.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('nvim-switch shows auto target and project/file entries', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nvim-ext-switch-'))
  vi.stubEnv('PI_NVIM_BRIDGE_DIR', tmpDir)

  const repoA = path.join(os.homedir(), 'repo-a')
  const repoB = path.join(os.homedir(), 'repo-b')

  const bridgeA = await startBridgeServer(() => ({
    ok: true,
    context: {
      project_root: repoA,
      relative_path: 'lua/a.lua',
      cursor: { line: 10, col: 0 },
      selection: { active: false },
      nvim: { version: '0.11.5' },
    },
  }))
  const bridgeB = await startBridgeServer(() => ({
    ok: true,
    context: {
      project_root: repoB,
      relative_path: 'lua/b.lua',
      cursor: { line: 3, col: 0 },
      selection: { active: false },
      nvim: { version: '0.11.5' },
    },
  }))

  fs.mkdirSync(path.join(tmpDir, 'a'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'b'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, 'a', 'lock.json'),
    JSON.stringify({ host: bridgeA.host, port: bridgeA.port, token: 'test', project_root: repoA }),
  )
  fs.writeFileSync(
    path.join(tmpDir, 'b', 'lock.json'),
    JSON.stringify({ host: bridgeB.host, port: bridgeB.port, token: 'test', project_root: repoB }),
  )

  const ui = makeUi()
  ui.select.mockResolvedValue('Auto (~/repo-a • lua/a.lua)')
  const { commands } = loadExtension()
  const command = commands.find((entry) => entry.name === 'nvim-switch')

  await command!.handler('', {
    cwd: repoA,
    hasUI: true,
    ui,
  })

  const items = ui.select.mock.calls[0]![1] as string[]
  expect(items).toEqual([
    'Auto (~/repo-a • lua/a.lua)',
    '~/repo-a • lua/a.lua',
    '~/repo-b • lua/b.lua',
  ])
  expect(ui.notify).toHaveBeenCalledWith('Neovim bridge selection reset to auto', 'info')

  await bridgeA.stop()
  await bridgeB.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('auto mode does not fall back to another project when current project bridge is gone', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nvim-ext-auto-'))
  vi.stubEnv('PI_NVIM_BRIDGE_DIR', tmpDir)

  const repoA = path.join(os.homedir(), 'repo-a')
  const repoB = path.join(os.homedir(), 'repo-b')
  const bridgeB = await startBridgeServer((target) => ({
    ok: true,
    target,
    context: {
      project_root: repoB,
      relative_path: 'lua/b.lua',
      cursor: { line: 7, col: 0 },
      selection: { active: false },
      nvim: { version: '0.11.5' },
    },
  }))

  fs.mkdirSync(path.join(tmpDir, 'b'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, 'b', 'lock.json'),
    JSON.stringify({ host: bridgeB.host, port: bridgeB.port, token: 'test', project_root: repoB }),
  )

  const { tools } = loadExtension()
  const tool = tools[0]!
  const result = await tool.execute('call_1', { target: 'current' }, undefined, undefined, {
    cwd: repoA,
  })

  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('No pi.nvim bridge lockfile found')

  await bridgeB.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('manual mode sticks to selected instance across cwd changes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nvim-ext-manual-'))
  vi.stubEnv('PI_NVIM_BRIDGE_DIR', tmpDir)

  const repoA = path.join(os.homedir(), 'repo-a')
  const repoB = path.join(os.homedir(), 'repo-b')

  const bridgeA = await startBridgeServer(() => ({
    ok: true,
    context: {
      project_root: repoA,
      relative_path: 'lua/a.lua',
      cursor: { line: 10, col: 0 },
      selection: { active: false },
      nvim: { version: '0.11.5' },
    },
    text: 'A',
  }))
  const bridgeB = await startBridgeServer(() => ({
    ok: true,
    context: {
      project_root: repoB,
      relative_path: 'lua/b.lua',
      cursor: { line: 3, col: 0 },
      selection: { active: false },
      nvim: { version: '0.11.5' },
    },
    text: 'B',
  }))

  fs.mkdirSync(path.join(tmpDir, 'a'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'b'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, 'a', 'lock.json'),
    JSON.stringify({ host: bridgeA.host, port: bridgeA.port, token: 'test', project_root: repoA }),
  )
  fs.writeFileSync(
    path.join(tmpDir, 'b', 'lock.json'),
    JSON.stringify({ host: bridgeB.host, port: bridgeB.port, token: 'test', project_root: repoB }),
  )

  const ui = makeUi()
  ui.select.mockResolvedValue('~/repo-b • lua/b.lua')
  const { commands, tools } = loadExtension()
  await commands
    .find((entry) => entry.name === 'nvim-switch')!
    .handler('', { cwd: repoA, hasUI: true, ui })

  const result = await tools[0]!.execute('call_1', { target: 'current' }, undefined, undefined, {
    cwd: repoA,
  })
  expect(result.isError).not.toBe(true)
  expect(result.content[0].text).toContain('lua/b.lua')

  await bridgeA.stop()
  await bridgeB.stop()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('status hides after reconnect timeout elapses', async () => {
  vi.useFakeTimers()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nvim-ext-reconnect-'))
  vi.stubEnv('PI_NVIM_BRIDGE_DIR', tmpDir)

  const repo = path.join(os.homedir(), 'repo-a')
  const bridge = await startBridgeServer(() => ({
    ok: true,
    context: {
      project_root: repo,
      relative_path: 'lua/a.lua',
      cursor: { line: 1, col: 0 },
      selection: { active: false },
      nvim: { version: '0.11.5' },
    },
  }))

  fs.mkdirSync(path.join(tmpDir, 'a'), { recursive: true })
  const lockfilePath = path.join(tmpDir, 'a', 'lock.json')
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({ host: bridge.host, port: bridge.port, token: 'test', project_root: repo }),
  )

  const ui = makeUi()
  const { sessionStartHandlers } = loadExtension()
  await sessionStartHandlers[0]!({}, { cwd: repo, hasUI: true, ui })
  expect(ui.setStatus).toHaveBeenLastCalledWith('nvim-bridge', expect.stringContaining('✓'))

  await bridge.stop()
  fs.rmSync(lockfilePath, { force: true })

  await vi.advanceTimersByTimeAsync(400)
  await vi.waitFor(() => {
    expect(ui.setStatus).toHaveBeenLastCalledWith(
      'nvim-bridge',
      expect.stringContaining('Reconnecting'),
    )
  })

  await vi.advanceTimersByTimeAsync(5200)
  await vi.waitFor(() => {
    expect(ui.setStatus).toHaveBeenLastCalledWith('nvim-bridge', undefined)
  })

  vi.useRealTimers()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
