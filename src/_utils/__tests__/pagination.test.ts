import { describe, it, expect } from 'vitest'
import { paginateAll } from '../../_utils/pagination.js'

describe('paginateAll', () => {
  it('should return all items from a single page', async () => {
    const pages = [{ items: [1, 2, 3], nextToken: undefined as string | undefined }]
    let callCount = 0

    const result = await paginateAll(
      () => Promise.resolve(pages[callCount++]!),
      (page) => page.items,
      (page) => page.nextToken,
    )

    expect(result).toEqual([1, 2, 3])
    expect(callCount).toBe(1)
  })

  it('should accumulate items across multiple pages', async () => {
    const pages = [
      { items: [1, 2], nextToken: 'tok1' as string | undefined },
      { items: [3, 4], nextToken: 'tok2' as string | undefined },
      { items: [5], nextToken: undefined as string | undefined },
    ]
    let callCount = 0
    const tokensReceived: (string | undefined)[] = []

    const result = await paginateAll(
      (nextToken) => {
        tokensReceived.push(nextToken)
        return Promise.resolve(pages[callCount++]!)
      },
      (page) => page.items,
      (page) => page.nextToken,
    )

    expect(result).toEqual([1, 2, 3, 4, 5])
    expect(tokensReceived).toEqual([undefined, 'tok1', 'tok2'])
  })

  it('should return empty array when page has no items', async () => {
    const result = await paginateAll(
      () => Promise.resolve({ items: undefined as number[] | undefined, nextToken: undefined }),
      (page) => page.items,
      (page) => page.nextToken,
    )

    expect(result).toEqual([])
  })
})
