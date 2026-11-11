import { describe, expect, it, vi } from 'vitest'

import { acceptWebSocketControl } from '../src/main/smoke/extension-network'

describe('extension network WebSocket control', () => {
  it('keeps the upgraded socket live after writing the accepted handshake', () => {
    const socket = { write: vi.fn(() => true) }

    acceptWebSocketControl(
      { headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } },
      socket,
    )

    expect(socket.write).toHaveBeenCalledWith(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n',
    )
  })
})
