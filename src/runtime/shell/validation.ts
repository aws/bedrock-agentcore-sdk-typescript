/** Validation for shell identifiers. */

const SHELL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

/**
 * Validate a shell ID.
 * Must start with alphanumeric, contain only alphanumeric, _ or -, max 128 chars.
 * @throws Error if invalid.
 */
export function validateShellId(shellId: string): void {
  if (typeof shellId !== 'string') {
    throw new Error(`shellId must be a string, got ${typeof shellId}`)
  }
  if (!SHELL_ID_RE.test(shellId)) {
    throw new Error(
      `Invalid shellId ${JSON.stringify(shellId)}: must start with alphanumeric, ` +
        `contain only [a-zA-Z0-9_-], and be 1–128 characters long`
    )
  }
}
