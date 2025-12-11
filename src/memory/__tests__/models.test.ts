import { describe, it, expect } from 'vitest'
import { DictWrapper } from '../models/dict-wrapper.js'

describe('DictWrapper', () => {
  it('provides property access', () => {
    const data = { foo: 'bar' }
    const wrapper = new DictWrapper(data)
    expect((wrapper as any).foo).toBe('bar')
  })

  it('provides dictionary access', () => {
    const data = { foo: 'bar' }
    const wrapper = new DictWrapper(data)
    expect(wrapper['foo']).toBe('bar')
  })

  it('provides get method', () => {
    const data: Record<string, unknown> = { foo: 'bar' }
    const wrapper = new DictWrapper(data)
    expect(wrapper.get('foo')).toBe('bar')
    expect(wrapper.get('baz', 'default')).toBe('default')
  })
})
