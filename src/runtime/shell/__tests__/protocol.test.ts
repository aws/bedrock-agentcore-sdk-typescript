import { describe, it, expect } from 'vitest'
import { ShellChannel, ShellFramer, MAX_FRAME_SIZE } from '../protocol.js'

describe('ShellChannel', () => {
  it('has correct wire values', () => {
    expect(ShellChannel.STDIN).toBe(0x00)
    expect(ShellChannel.STDOUT).toBe(0x01)
    expect(ShellChannel.STDERR).toBe(0x02)
    expect(ShellChannel.STATUS).toBe(0x03)
    expect(ShellChannel.RESIZE).toBe(0x04)
    expect(ShellChannel.HEARTBEAT).toBe(0x05)
    expect(ShellChannel.CLOSE).toBe(0xff)
    expect(ShellChannel.UNKNOWN).toBe(-1)
  })
})

describe('ShellFramer.decode', () => {
  const framer = new ShellFramer()

  it('decodes STDOUT frame', () => {
    const raw = Buffer.concat([Buffer.from([ShellChannel.STDOUT]), Buffer.from('hello')])
    const frame = framer.decode(raw)
    expect(frame.channel).toBe(ShellChannel.STDOUT)
    expect(frame.rawChannelByte).toBe(0x01)
    expect(frame.payload).toEqual(Buffer.from('hello'))
    expect(frame.text).toBe('hello')
  })

  it('decodes STDIN frame', () => {
    const raw = Buffer.concat([Buffer.from([ShellChannel.STDIN]), Buffer.from('ls\n')])
    const frame = framer.decode(raw)
    expect(frame.channel).toBe(ShellChannel.STDIN)
    expect(frame.payload).toEqual(Buffer.from('ls\n'))
  })

  it('decodes STATUS frame with json()', () => {
    const payload = JSON.stringify({
      kind: 'Status',
      status: 'Success',
      metadata: { shellId: 'abc', reconnected: false },
    })
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)])
    const frame = framer.decode(raw)
    expect(frame.channel).toBe(ShellChannel.STATUS)
    expect(frame.json()['status']).toBe('Success')
  })

  it('decodes CLOSE frame with empty payload', () => {
    const raw = Buffer.from([ShellChannel.CLOSE])
    const frame = framer.decode(raw)
    expect(frame.channel).toBe(ShellChannel.CLOSE)
    expect(frame.payload.length).toBe(0)
  })

  it('decodes HEARTBEAT frame', () => {
    const raw = Buffer.from([ShellChannel.HEARTBEAT])
    const frame = framer.decode(raw)
    expect(frame.channel).toBe(ShellChannel.HEARTBEAT)
    expect(frame.payload.length).toBe(0)
  })

  it('decodes unknown channel byte as UNKNOWN', () => {
    const raw = Buffer.concat([Buffer.from([0x42]), Buffer.from('future data')])
    const frame = framer.decode(raw)
    expect(frame.channel).toBe(ShellChannel.UNKNOWN)
    expect(frame.rawChannelByte).toBe(0x42)
    expect(frame.payload).toEqual(Buffer.from('future data'))
  })

  it('UNKNOWN sentinel (-1) is not treated as a valid wire byte', () => {
    // 0xFF is CLOSE — verify UNKNOWN=-1 is not confused with any wire byte
    const raw = Buffer.from([0xff])
    const frame = framer.decode(raw)
    expect(frame.channel).toBe(ShellChannel.CLOSE)
    expect(frame.channel).not.toBe(ShellChannel.UNKNOWN)
  })

  it('throws on empty frame', () => {
    expect(() => framer.decode(Buffer.alloc(0))).toThrow('empty')
  })

  it('text property replaces invalid UTF-8 bytes', () => {
    const raw = Buffer.concat([Buffer.from([ShellChannel.STDOUT]), Buffer.from([0xff, 0xfe])])
    const frame = framer.decode(raw)
    expect(frame.text).toContain('�')
  })

  it('json() throws SyntaxError on invalid payload', () => {
    const raw = Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from('not json')])
    const frame = framer.decode(raw)
    expect(() => frame.json()).toThrow(SyntaxError)
  })
})

describe('ShellFramer.encodeStdin', () => {
  const framer = new ShellFramer()

  it('encodes string as STDIN frame', () => {
    const frame = framer.encodeStdin('ls\n')
    expect(frame[0]).toBe(ShellChannel.STDIN)
    expect(frame.slice(1)).toEqual(Buffer.from('ls\n'))
  })

  it('encodes Buffer as STDIN frame', () => {
    const data = Buffer.from([0x1b, 0x5b, 0x41]) // ESC[A
    const frame = framer.encodeStdin(data)
    expect(frame[0]).toBe(ShellChannel.STDIN)
    expect(frame.slice(1)).toEqual(data)
  })

  it('throws when payload exceeds 64KB limit', () => {
    const big = 'x'.repeat(MAX_FRAME_SIZE)
    expect(() => framer.encodeStdin(big)).toThrow('64 KB')
  })

  it('accepts payload exactly at limit (MAX_FRAME_SIZE - 1 bytes)', () => {
    const data = Buffer.alloc(MAX_FRAME_SIZE - 1)
    const frame = framer.encodeStdin(data)
    expect(frame.length).toBe(MAX_FRAME_SIZE)
  })

  it('round-trips through decode', () => {
    const original = 'echo hello\n'
    const encoded = framer.encodeStdin(original)
    const decoded = framer.decode(encoded)
    expect(decoded.channel).toBe(ShellChannel.STDIN)
    expect(decoded.text).toBe(original)
  })
})

describe('ShellFramer.encodeResize', () => {
  const framer = new ShellFramer()

  it('encodes resize frame', () => {
    const frame = framer.encodeResize(220, 50)
    expect(frame[0]).toBe(ShellChannel.RESIZE)
    expect(JSON.parse(frame.slice(1).toString())).toEqual({ width: 220, height: 50 })
  })

  it.each([
    [0, 24],
    [80, 0],
    [-1, 24],
    [80, -1],
    [0, 0],
  ])('throws for invalid dimensions width=%i height=%i', (w, h) => {
    expect(() => framer.encodeResize(w, h)).toThrow('positive integers')
  })

  it('throws for non-integer dimensions', () => {
    expect(() => framer.encodeResize(10.5, 24)).toThrow('integers')
    expect(() => framer.encodeResize(80, 24.1)).toThrow('integers')
  })
})

describe('ShellFramer.encodeHeartbeat', () => {
  it('encodes heartbeat as single byte', () => {
    const framer = new ShellFramer()
    const frame = framer.encodeHeartbeat()
    expect(frame).toEqual(Buffer.from([ShellChannel.HEARTBEAT]))
  })
})
