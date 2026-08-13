import { connect as connectSocket, type Socket } from 'node:net'
import { Duplex } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectHost } from '../src/main/project-host/project-host'
import { LoopbackHttpProxy } from '../src/main/web-pane/loopback-http-proxy'
import { asHostId } from '../src/shared'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const ENDPOINT = { hostname: 'localhost', port: 8501 } as const
const AUTHORITY = `${ENDPOINT.hostname}:${ENDPOINT.port}`

/** An upstream the test drives directly, standing in for an ssh2 Channel. */
function controlledUpstream(): Duplex {
  return new Duplex({
    read() {
      // The test pushes when it wants the proxy to write toward the browser.
    },
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

function tunnelProxy(upstream: Duplex): LoopbackHttpProxy {
  const host = {
    hostId: asHostId('remote-test'),
    connectLoopback: () => Promise.resolve(upstream),
  } as unknown as ProjectHost
  return new LoopbackHttpProxy({ host, endpoint: ENDPOINT })
}

/** A proxy whose route resolution stays in flight until the test releases it. */
function deferredTunnelProxy(upstream: Duplex): {
  readonly proxy: LoopbackHttpProxy
  /** Resolves once the proxy is awaiting the route. */
  readonly routing: Promise<void>
  readonly release: () => void
} {
  let announceRouting: () => void = () => undefined
  let release: () => void = () => undefined
  const routing = new Promise<void>((resolve) => {
    announceRouting = resolve
  })
  const host = {
    hostId: asHostId('remote-test'),
    connectLoopback: () =>
      new Promise<Duplex>((resolve) => {
        release = () => resolve(upstream)
        announceRouting()
      }),
  } as unknown as ProjectHost
  return {
    proxy: new LoopbackHttpProxy({ host, endpoint: ENDPOINT }),
    routing,
    release: () => release(),
  }
}

/** Opens a CONNECT tunnel and resolves once the proxy confirms it. */
function openTunnel(
  port: number,
  credentials: { readonly username: string; readonly password: string },
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(port, '127.0.0.1', () => {
      const auth = Buffer.from(
        `${credentials.username}:${credentials.password}`,
      ).toString('base64')
      socket.write(
        `CONNECT ${AUTHORITY} HTTP/1.1\r\nHost: ${AUTHORITY}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
      )
    })
    socket.once('error', reject)
    socket.once('data', (chunk) => {
      if (!String(chunk).includes(' 200 ')) {
        reject(new Error(`Tunnel refused: ${String(chunk).slice(0, 60)}`))
        return
      }
      resolve(socket)
    })
  })
}

/** Collects what Node would otherwise report as a fatal uncaught error. */
function captureFatalErrors(): { readonly errors: Error[]; restore: () => void } {
  const errors: Error[] = []
  const collect = (error: Error): void => {
    errors.push(error)
  }
  const displaced = process.listeners('uncaughtException')
  for (const listener of displaced) process.off('uncaughtException', listener)
  process.on('uncaughtException', collect)
  return {
    errors,
    restore: () => {
      process.off('uncaughtException', collect)
      for (const listener of displaced) process.on('uncaughtException', listener)
    },
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

describe('web pane tunnel teardown', () => {
  it('survives a browser socket reset while the tunnel carries upstream data', async () => {
    const upstream = controlledUpstream()
    const proxy = tunnelProxy(upstream)
    await proxy.open()
    cleanups.push(() => proxy.close())

    const socket = await openTunnel(proxy.port, proxy.credentials)
    const fatal = captureFatalErrors()
    cleanups.push(() => fatal.restore())

    // The browser side vanishes without a FIN, exactly as a closed pane does.
    socket.resetAndDestroy()
    await settle()
    // The upstream is still streaming into a socket that no longer exists.
    upstream.push('HTTP/1.1 200 OK\r\n\r\npayload-after-reset')
    await settle()

    expect(fatal.errors.map((error) => error.message)).toEqual([])
  })

  it('survives a browser socket reset while a proxied response is streaming', async () => {
    let sink: Duplex | undefined
    const upstream = new Duplex({
      read() {
        // Driven by the test once the proxy has written its request.
      },
      write(_chunk, _encoding, callback) {
        sink = upstream
        callback()
      },
    })
    const proxy = tunnelProxy(upstream)
    await proxy.open()
    cleanups.push(() => proxy.close())

    const socket = connectSocket(proxy.port, '127.0.0.1', () => {
      const auth = Buffer.from(
        `${proxy.credentials.username}:${proxy.credentials.password}`,
      ).toString('base64')
      socket.write(
        `GET http://${AUTHORITY}/stream HTTP/1.1\r\nHost: ${AUTHORITY}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
      )
    })
    socket.on('error', () => undefined)
    await settle()
    expect(sink).toBeDefined()

    const fatal = captureFatalErrors()
    cleanups.push(() => fatal.restore())
    // Headers say more is coming, then the pane dies mid-body.
    upstream.push('HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\nfirst-chunk')
    await settle()
    socket.resetAndDestroy()
    await settle()
    upstream.push('second-chunk-after-the-browser-is-gone')
    await settle()

    expect(fatal.errors.map((error) => error.message)).toEqual([])
  })

  it('survives a pane reset while the tunnel route is still resolving', async () => {
    const upstream = controlledUpstream()
    const { proxy, routing, release } = deferredTunnelProxy(upstream)
    await proxy.open()
    cleanups.push(() => proxy.close())

    const socket = connectSocket(proxy.port, '127.0.0.1', () => {
      const auth = Buffer.from(
        `${proxy.credentials.username}:${proxy.credentials.password}`,
      ).toString('base64')
      socket.write(
        `CONNECT ${AUTHORITY} HTTP/1.1\r\nHost: ${AUTHORITY}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
      )
    })
    socket.on('error', () => undefined)
    await routing

    const fatal = captureFatalErrors()
    cleanups.push(() => fatal.restore())
    // The pane closes before the proxy has anything to tunnel it to.
    socket.resetAndDestroy()
    await settle()
    release()
    await settle()

    expect(fatal.errors.map((error) => error.message)).toEqual([])
    expect(upstream.destroyed).toBe(true)
  })

  it('keeps serving new tunnels after a peer resets', async () => {
    const proxy = tunnelProxy(controlledUpstream())
    await proxy.open()
    cleanups.push(() => proxy.close())

    const doomed = await openTunnel(proxy.port, proxy.credentials)
    const fatal = captureFatalErrors()
    cleanups.push(() => fatal.restore())
    doomed.resetAndDestroy()
    await settle()

    const survivor = await openTunnel(proxy.port, proxy.credentials)
    expect(survivor.destroyed).toBe(false)
    survivor.destroy()
    expect(fatal.errors.map((error) => error.message)).toEqual([])
  })
})
