/*
 * Binary channel-prefix framer for InvokeAgentRuntimeCommandShell.
 *
 * Wire format (identical to Kubernetes v5.channel.k8s.io):
 *   [1-byte channel ID][payload bytes]
 *
 * Channels:
 *   0x00  STDIN      Raw bytes, client → shell
 *   0x01  STDOUT     Raw bytes, shell → client
 *   0x02  STDERR     UTF-8 text (platform diagnostics), shell → client
 *   0x03  STATUS     metav1.Status JSON (shell → client):
 *                      Connection confirmation: metadata.shellId present
 *                      {"kind":"Status","apiVersion":"v1",
 *                       "metadata":{"shellId":"…","reconnected":bool},"status":"Success"}
 *                      Shell exit (code 0):
 *                      {"kind":"Status","apiVersion":"v1","metadata":{},"status":"Success"}
 *                      Shell exit (non-zero):
 *                      {"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure",
 *                       "reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"N"}]}}
 *   0x04  RESIZE     JSON {"width":N,"height":N}, client → shell
 *   0x05  HEARTBEAT  Empty payload, bidirectional keepalive
 *   0xFF  CLOSE      Empty payload. Client → server: explicit session kill (SIGHUP → SIGKILL).
 *                    Server echoes [0xFF] back, kills the shell, closes WebSocket with code 1000.
 *                    Unlike disconnect (which detaches), 0xFF is permanent — no reconnection possible.
 */

import { Buffer } from 'buffer'

/** Wire channel identifiers for the binary channel-prefix protocol. */
export enum ShellChannel {
  STDIN = 0x00,
  STDOUT = 0x01,
  STDERR = 0x02,
  STATUS = 0x03,
  RESIZE = 0x04,
  HEARTBEAT = 0x05,
  CLOSE = 0xff,
  /** Sentinel for unrecognised channel bytes — not a wire value. */
  UNKNOWN = -1,
}

// Pre-built set of known wire channel bytes (excludes UNKNOWN sentinel).
const KNOWN_CHANNEL_BYTES = new Set(
  Object.values(ShellChannel).filter((v): v is ShellChannel => typeof v === 'number' && v !== ShellChannel.UNKNOWN)
)

/** A single decoded WebSocket frame from the shell stream. */
export interface ShellFrame {
  /** The channel this frame belongs to. UNKNOWN for unrecognised channel bytes. */
  channel: ShellChannel
  /** The original channel byte from the wire. */
  rawChannelByte: number
  /** Raw bytes of the frame payload (everything after the channel byte). */
  payload: Buffer
  /** Decode payload as UTF-8 text (replacement char on invalid bytes). */
  readonly text: string
  /** Parse payload as JSON. Throws SyntaxError if payload is not valid JSON. */
  json(): Record<string, unknown>
}

/** Maximum frame size — matches DP WebSocketFlowController limit. */
export const MAX_FRAME_SIZE = 64 * 1024

function makeFrame(channel: ShellChannel, rawChannelByte: number, payload: Buffer): ShellFrame {
  return {
    channel,
    rawChannelByte,
    payload,
    get text(): string {
      return payload.toString('utf8')
    },
    json(): Record<string, unknown> {
      return JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    },
  }
}

/**
 * Encodes and decodes binary channel-prefix WebSocket frames.
 * Stateless — a single instance is safe to reuse across frames.
 */
export class ShellFramer {
  /** Decode one raw WebSocket binary message into a ShellFrame. */
  decode(frame: Buffer): ShellFrame {
    if (frame.length === 0) {
      throw new Error('Cannot decode empty frame')
    }
    const rawByte = frame[0]!
    const channel = KNOWN_CHANNEL_BYTES.has(rawByte as ShellChannel) ? (rawByte as ShellChannel) : ShellChannel.UNKNOWN
    return makeFrame(channel, rawByte, frame.slice(1))
  }

  /** Encode keyboard input or paste data as a STDIN frame. */
  encodeStdin(data: string | Buffer): Buffer {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (bytes.length > MAX_FRAME_SIZE - 1) {
      throw new Error(
        `Payload ${bytes.length} bytes exceeds the 64 KB frame limit. Split large pastes into multiple encodeStdin() calls.`
      )
    }
    return Buffer.concat([Buffer.from([ShellChannel.STDIN]), bytes])
  }

  /** Encode a terminal resize event as a RESIZE frame. */
  encodeResize(width: number, height: number): Buffer {
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error(`width and height must be integers, got ${typeof width} and ${typeof height}`)
    }
    if (width <= 0 || height <= 0) {
      throw new Error(`width and height must be positive integers, got width=${width}, height=${height}`)
    }
    const payload = Buffer.from(JSON.stringify({ width, height }), 'utf8')
    return Buffer.concat([Buffer.from([ShellChannel.RESIZE]), payload])
  }

  /** Encode an app-level heartbeat frame (channel 0x05, empty payload). */
  encodeHeartbeat(): Buffer {
    return Buffer.from([ShellChannel.HEARTBEAT])
  }
}
