import { describe, expect, it } from 'vitest'

import { calculateScale } from '../scaling.js'

describe('calculateScale', () => {
  it('returns zero scale for zero-size container', () => {
    expect(calculateScale(0, 0, 1920, 1080)).toEqual({ scale: 0, offsetX: 0 })
  })

  it('returns zero scale for zero-width container', () => {
    expect(calculateScale(0, 500, 1920, 1080)).toEqual({ scale: 0, offsetX: 0 })
  })

  it('returns zero scale for zero-height container', () => {
    expect(calculateScale(500, 0, 1920, 1080)).toEqual({ scale: 0, offsetX: 0 })
  })

  it('returns zero scale for negative dimensions', () => {
    expect(calculateScale(-100, 500, 1920, 1080)).toEqual({ scale: 0, offsetX: 0 })
  })

  it('scales to fit width when container is narrower', () => {
    const { scale, offsetX } = calculateScale(960, 1080, 1920, 1080)
    expect(scale).toBeCloseTo(0.5)
    expect(offsetX).toBe(0)
  })

  it('scales to fit height when container is shorter', () => {
    const { scale, offsetX } = calculateScale(1920, 540, 1920, 1080)
    expect(scale).toBeCloseTo(0.5)
    expect(offsetX).toBeGreaterThan(0)
  })

  it('centers horizontally when height-constrained', () => {
    const { scale, offsetX } = calculateScale(1920, 540, 1920, 1080)
    expect(scale).toBeCloseTo(0.5)
    expect(offsetX).toBeCloseTo(480)
  })

  it('returns scale 1 when container matches remote exactly', () => {
    const { scale, offsetX } = calculateScale(1920, 1080, 1920, 1080)
    expect(scale).toBeCloseTo(1)
    expect(offsetX).toBeCloseTo(0)
  })

  it('scales up when container is larger than remote', () => {
    const { scale, offsetX } = calculateScale(3840, 2160, 1920, 1080)
    expect(scale).toBeCloseTo(2)
    expect(offsetX).toBeCloseTo(0)
  })

  it('handles portrait remote viewport', () => {
    const { scale, offsetX } = calculateScale(400, 800, 1080, 1920)
    expect(scale).toBeCloseTo(400 / 1080)
    expect(offsetX).toBe(0)
  })

  it('handles wide container with portrait remote', () => {
    const { scale, offsetX } = calculateScale(1000, 500, 1080, 1920)
    expect(scale).toBeCloseTo(500 / 1920)
    expect(offsetX).toBeGreaterThan(0)
  })

  it('handles square container with landscape remote', () => {
    const { scale, offsetX } = calculateScale(500, 500, 1920, 1080)
    expect(scale).toBeCloseTo(500 / 1920)
    expect(offsetX).toBeCloseTo(0)
  })
})
