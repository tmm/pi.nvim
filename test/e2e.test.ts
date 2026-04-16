import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

import { expect, test } from 'vitest'

type Lockfile = {
  host: string
  port: number
  token: string
  project_root?: string
}

type BridgeResponse = {
  ok: boolean
  context?: {
    relative_path?: string
    file?: string
    selection?: {
      active?: boolean
      start?: { line?: number }
      end?: { line?: number }
    }
  }
  text?: string
}

function repoRoot() {
  return path.resolve(import.meta.dirname, '..')
}

async function startNvim(cwd: string, filePath: string, cacheHome: string) {
  const socketPath = path.join(cwd, 'nvim.sock')
  const child = spawn(
    'nvim',
    [
      '--headless',
      '--clean',
      '--listen',
      socketPath,
      '+set rtp+=' + repoRoot().replace(/ /g, '\\ '),
      "+lua require('pi').setup({ auto_install_pi_extension = false, notify_on_install = false })",
      `+edit ${filePath.replace(/ /g, '\\ ')}`,
    ],
    {
      cwd,
      env: {
        ...process.env,
        XDG_CACHE_HOME: cacheHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })

  await waitFor(
    () => fs.existsSync(socketPath),
    5000,
    `nvim socket not created. stderr:\n${stderr}`,
  )

  return {
    socketPath,
    stop: async () => {
      spawn('nvim', ['--server', socketPath, '--remote-send', '<Esc>:qa!<CR>'])
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    },
    send: async (keys: string) => {
      await runRemote(socketPath, ['--remote-send', keys])
    },
    expr: async (expr: string) => await runRemote(socketPath, ['--remote-expr', expr]),
  }
}

async function runRemote(socketPath: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('nvim', ['--server', socketPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr || `remote command failed with ${code}`))
    })
  })
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs: number, message: string) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function waitForLockfile(cacheHome: string) {
  const base = path.join(cacheHome, 'nvim', 'pi-bridge')
  const lockfile = await waitFor(
    () => {
      if (!fs.existsSync(base)) return undefined
      for (const dir of fs.readdirSync(base)) {
        const candidate = path.join(base, dir, 'lock.json')
        if (fs.existsSync(candidate)) return candidate
      }
    },
    5000,
    'lockfile not found',
  )

  return lockfile
}

async function queryBridge(lockfile: Lockfile, target: string): Promise<BridgeResponse> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(lockfile.port, lockfile.host)
    let raw = ''
    socket.setTimeout(2000)
    socket.on('connect', () => {
      socket.end(JSON.stringify({ token: lockfile.token, target }) + '\n')
    })
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8')
    })
    socket.on('timeout', () => reject(new Error('bridge timeout')))
    socket.on('error', reject)
    socket.on('close', () => resolve(JSON.parse(raw.trim()) as BridgeResponse))
  })
}

test('nvim bridge serves current file and active selection', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nvim-e2e-'))
  const cacheHome = path.join(tmpDir, 'cache')
  const filePath = path.join(tmpDir, 'example.ts')
  fs.writeFileSync(filePath, 'const one = 1\nconst two = 2\nconst three = 3\n')

  const nvim = await startNvim(tmpDir, filePath, cacheHome)

  try {
    const lockfilePath = await waitForLockfile(cacheHome)
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')) as Lockfile

    const current = await queryBridge(lockfile, 'current')
    expect(current.ok).toBe(true)
    expect(current.context?.relative_path).toBe('example.ts')
    expect(current.text).toContain('const two = 2')

    await nvim.send('<Esc>ggVj')
    await new Promise((resolve) => setTimeout(resolve, 200))

    const selection = await queryBridge(lockfile, 'selection')
    expect(selection.ok).toBe(true)
    expect(selection.context?.selection?.active).toBe(true)
    expect(selection.text).toContain('const one = 1')
    expect(selection.text).toContain('const two = 2')
  } finally {
    await nvim.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('nvim bridge keeps last selection text but marks it inactive after leaving visual mode', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-nvim-e2e-inactive-'))
  const cacheHome = path.join(tmpDir, 'cache')
  const filePath = path.join(tmpDir, 'example.ts')
  fs.writeFileSync(filePath, 'const one = 1\nconst two = 2\nconst three = 3\n')

  const nvim = await startNvim(tmpDir, filePath, cacheHome)

  try {
    const lockfilePath = await waitForLockfile(cacheHome)
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')) as Lockfile

    await nvim.send('<Esc>ggVj')
    await new Promise((resolve) => setTimeout(resolve, 200))
    await nvim.send('<Esc>')
    await new Promise((resolve) => setTimeout(resolve, 200))

    const selection = await queryBridge(lockfile, 'selection')
    expect(selection.ok).toBe(true)
    expect(selection.context?.selection?.active).toBe(false)
    expect(selection.text).toContain('const one = 1')
    expect(selection.text).toContain('const two = 2')
  } finally {
    await nvim.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
