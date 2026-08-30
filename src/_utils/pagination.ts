export const DEFAULT_PAGE_SIZE = 100

/**
 * Paginate any SDK method that follows the nextToken request/response pattern.
 *
 * @param fetchPage - Fetches a single page, given an optional nextToken
 * @param getItems - Extracts the item array from each page response
 * @param getNextToken - Extracts the nextToken from each page response
 * @returns All items accumulated across pages
 *
 * @example
 * ```typescript
 * const allEvents = await paginateAll(
 *   (nextToken) => client.listEvents({ memoryId, actorId, sessionId, nextToken }),
 *   (page) => page.events,
 *   (page) => page.nextToken,
 * );
 * ```
 */
export async function paginateAll<TOutput, TItem>(
  fetchPage: (nextToken?: string) => Promise<TOutput>,
  getItems: (output: TOutput) => TItem[] | undefined,
  getNextToken: (output: TOutput) => string | undefined,
): Promise<TItem[]> {
  const items: TItem[] = []
  let nextToken: string | undefined
  do {
    const page = await fetchPage(nextToken)
    const pageItems = getItems(page)
    if (pageItems) items.push(...pageItems)
    nextToken = getNextToken(page)
  } while (nextToken)
  return items
}
