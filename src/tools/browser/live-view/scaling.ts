/**
 * Calculate the scale factor and horizontal offset to fit a remote viewport
 * into a container while preserving aspect ratio.
 */
export function calculateScale(
  containerWidth: number,
  containerHeight: number,
  remoteWidth: number,
  remoteHeight: number
): { scale: number; offsetX: number } {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return { scale: 0, offsetX: 0 }
  }
  const scale = Math.min(containerWidth / remoteWidth, containerHeight / remoteHeight)
  const offsetX = Math.max(0, (containerWidth - remoteWidth * scale) / 2)
  return { scale, offsetX }
}
