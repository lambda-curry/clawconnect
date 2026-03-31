import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

// ── Device identity ───────────────────────────────────────────────────────────

// Reuse the existing paired currychat device identity
const DEVICE_FILE = join(homedir(), '.openclaw', 'clawd-ui-device.json')

interface DeviceIdentity {
  version: 1
  deviceId: string
  publicKey: string
  privateKey: string
}

function toBase64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateDevice(): DeviceIdentity {
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync('ed25519')
  const privJwk = priv.export({ format: 'jwk' }) as { d: string }
  const pubJwk = pub.export({ format: 'jwk' }) as { x: string }
  const pubBytes = Buffer.from(pubJwk.x, 'base64url')
  const privBytes = Buffer.from(privJwk.d, 'base64url')
  const deviceId = createHash('sha256').update(pubBytes).digest('hex')
  return { version: 1, deviceId, publicKey: toBase64url(pubBytes), privateKey: toBase64url(privBytes) }
}

function loadOrCreateDevice(): DeviceIdentity {
  if (existsSync(DEVICE_FILE)) {
    try {
      const d = JSON.parse(readFileSync(DEVICE_FILE, 'utf8')) as DeviceIdentity
      if (d.version === 1 && d.deviceId && d.publicKey && d.privateKey) return d
    } catch {}
  }
  const d = generateDevice()
  mkdirSync(join(homedir(), '.openclaw'), { recursive: true })
  writeFileSync(DEVICE_FILE, JSON.stringify(d, null, 2), { mode: 0o600 })
  console.log('[openclaw-gateway] generated new device identity')
  return d
}

function signChallenge(input: {
  privateKey: string
  deviceId: string
  signedAt: number
  nonce: string
  token: string
}): string {
  const payload = [
    'v3',
    input.deviceId,
    'gateway-client',
    'backend',
    'operator',
    'operator.read,operator.write,operator.admin',
    String(input.signedAt),
    input.token,
    input.nonce,
    'node',
    '',
  ].join('|')

  const privBytes = Buffer.from(input.privateKey, 'base64url')
  const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
  const pkcs8Der = Buffer.concat([PKCS8_PREFIX, privBytes])
  const key = createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' })
  return toBase64url(sign(null, Buffer.from(payload), key))
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Frame {
  type: 'req' | 'res' | 'event'
  id?: string
  ok?: boolean
  payload?: unknown
  error?: unknown
  event?: string
  method?: string
}

interface ChatEventPayload {
  runId: string
  sessionKey: string
  state: 'delta' | 'final' | 'aborted' | 'error'
  message?: { content: Array<{ type: string; text?: string; thinking?: string }> }
  errorMessage?: string
}

// ── Gateway client ────────────────────────────────────────────────────────────

export class OpenClawGateway {
  private ws: WebSocket | null = null
  private subscribers = new Map<string, (frame: Frame) => void>()
  private pendingRpcs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private connectPromise: Promise<void> | null = null

  constructor(
    private readonly gatewayUrl: string,
    private readonly token: string,
  ) {}

  private wsUrl(): string {
    return this.gatewayUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this._connect()
    return this.connectPromise
  }

  private _connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const device = loadOrCreateDevice()
      const ws = new WebSocket(this.wsUrl())
      const connectId = randomUUID()

      const timeout = setTimeout(() => {
        ws.terminate()
        reject(new Error('OpenClaw handshake timeout'))
      }, 15_000)

      const onHandshake = (raw: WebSocket.RawData) => {
        let frame: Frame
        try { frame = JSON.parse(raw.toString()) as Frame } catch { return }

        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          const { nonce } = frame.payload as { nonce: string }
          const signedAt = Date.now()
          ws.send(JSON.stringify({
            type: 'req',
            id: connectId,
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: { id: 'gateway-client', version: 'internal', platform: 'node', mode: 'backend' },
              role: 'operator',
              scopes: ['operator.read', 'operator.write', 'operator.admin'],
              caps: ['tool-events'],
              commands: [],
              permissions: {},
              auth: { token: this.token },
              device: {
                id: device.deviceId,
                publicKey: device.publicKey,
                signature: signChallenge({ privateKey: device.privateKey, deviceId: device.deviceId, signedAt, nonce, token: this.token }),
                signedAt,
                nonce,
              },
            },
          }))
          return
        }

        if (frame.type === 'res' && frame.id === connectId) {
          clearTimeout(timeout)
          ws.removeListener('message', onHandshake)
          if (!frame.ok) {
            reject(new Error(`OpenClaw connect rejected: ${JSON.stringify(frame.error)}`))
            ws.terminate()
            return
          }
          this.ws = ws
          this.attachHandlers(ws)
          console.log('[openclaw-gateway] connected')
          resolve()
        }
      }

      ws.on('message', onHandshake)
      ws.on('error', (err) => { clearTimeout(timeout); reject(err) })
      ws.once('close', () => { clearTimeout(timeout); reject(new Error('WebSocket closed during handshake')) })
    })
  }

  private attachHandlers(ws: WebSocket) {
    ws.removeAllListeners('message')
    ws.removeAllListeners('close')
    ws.removeAllListeners('error')

    ws.on('error', (err) => console.error('[openclaw-gateway] ws error:', err.message))

    ws.on('message', (raw) => {
      let frame: Frame
      try { frame = JSON.parse(raw.toString()) as Frame } catch { return }

      if (frame.type === 'res' && frame.id) {
        const rpc = this.pendingRpcs.get(frame.id)
        if (rpc) {
          this.pendingRpcs.delete(frame.id)
          if (frame.ok) rpc.resolve(frame.payload)
          else rpc.reject(new Error(JSON.stringify(frame.error)))
        }
      }

      for (const cb of this.subscribers.values()) {
        try { cb(frame) } catch {}
      }
    })

    ws.on('close', () => {
      console.log('[openclaw-gateway] disconnected')
      this.ws = null
      this.connectPromise = null
      for (const [id, rpc] of this.pendingRpcs) {
        rpc.reject(new Error('Gateway disconnected'))
        this.pendingRpcs.delete(id)
      }
    })
  }

  private sendRpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway not connected')
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, timeoutMs)

      this.pendingRpcs.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  /**
   * Send a message to a session and wait for the final response.
   * Returns the text of the assistant reply.
   */
  async chat(sessionKey: string, message: string, timeoutMs: number): Promise<string> {
    await this.connect()

    const idempotencyKey = randomUUID()

    const sendResult = await this.sendRpc('chat.send', { sessionKey, message, idempotencyKey }, 30_000) as { runId?: string }
    const runId = sendResult?.runId
    if (!runId) throw new Error('chat.send did not return a runId')

    return new Promise<string>((resolve, reject) => {
      const subId = randomUUID()

      const timer = setTimeout(() => {
        this.subscribers.delete(subId)
        reject(new Error('OpenClaw task timed out'))
      }, timeoutMs)

      this.subscribers.set(subId, (frame) => {
        if (frame.type !== 'event' || frame.event !== 'chat') return
        const payload = frame.payload as ChatEventPayload
        if (payload.runId !== runId) return

        if (payload.state === 'final') {
          clearTimeout(timer)
          this.subscribers.delete(subId)
          const blocks = payload.message?.content ?? []
          console.log('[openclaw-gateway] final content blocks:', JSON.stringify(blocks.map(b => ({ type: b.type, len: (b.text ?? b.thinking ?? '').length }))))
          const text = blocks
            .filter(b => b.type === 'text')
            .map(b => b.text ?? '')
            .join('')
          // fall back to thinking content if no text blocks
          const result = text || blocks
            .filter(b => b.type === 'thinking')
            .map(b => b.thinking ?? '')
            .join('')
          resolve(result)
        } else if (payload.state === 'aborted') {
          clearTimeout(timer)
          this.subscribers.delete(subId)
          reject(new Error('OpenClaw task aborted'))
        } else if (payload.state === 'error') {
          clearTimeout(timer)
          this.subscribers.delete(subId)
          reject(new Error(payload.errorMessage ?? 'OpenClaw task error'))
        }
      })
    })
  }
}
