/**
 * A wrapper class that provides dictionary-like access to data.
 * TypeScript version of Python's DictWrapper.
 *
 * Provides both property access and dictionary-style access to underlying data.
 */
export class DictWrapper<T extends Record<string, unknown> = Record<string, unknown>> {
  protected readonly _data: T

  constructor(data: T) {
    this._data = data

    // Create a Proxy to enable dynamic property access
    return new Proxy(this, {
      get(target, prop: string | symbol) {
        // First check if it's a method on the class
        if (prop in target) {
          return (target as Record<string | symbol, unknown>)[prop]
        }
        // Then check _data
        if (typeof prop === 'string' && prop in target._data) {
          return target._data[prop]
        }
        return undefined
      },
      has(target, prop: string | symbol) {
        if (typeof prop === 'string') {
          return prop in target._data
        }
        return false
      },
    })
  }

  /**
   * Get a value by key with optional default.
   */
  get<K extends keyof T>(key: K, defaultValue?: T[K]): T[K] | undefined {
    return this._data[key] ?? defaultValue
  }

  /**
   * Check if key exists in data.
   */
  has(key: string): boolean {
    return key in this._data
  }

  /**
   * Get all keys.
   */
  keys(): string[] {
    return Object.keys(this._data)
  }

  /**
   * Get all values.
   */
  values(): unknown[] {
    return Object.values(this._data)
  }

  /**
   * Get all entries.
   */
  entries(): [string, unknown][] {
    return Object.entries(this._data)
  }

  /**
   * Dictionary-style access.
   */
  [key: string]: unknown

  /**
   * Convert to plain object.
   */
  toJSON(): T {
    return this._data
  }

  /**
   * String representation.
   */
  toString(): string {
    return JSON.stringify(this._data)
  }
}
