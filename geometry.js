// Screen/window bounds are CSS pixels, not physical pixels. Negative monitor origins are valid.
export function geometry(size, frameWidth = 0, frameHeight = 0) {
  const finite = (v, fallback) => Number.isFinite(v) ? v : fallback;
  const width = Math.max(200, Math.min(20000, finite(size.width, 1920)));
  const height = Math.max(200, Math.min(20000, finite(size.height, 1080)));
  const ratio = Math.max(0.05, Math.min(20, finite(size.ratio, 16 / 9)));
  const fw = Math.max(0, Math.min(width - 100, frameWidth));
  const fh = Math.max(0, Math.min(height - 100, frameHeight));
  // Full available outer height; when a wide video cannot fill it, contain adds black bars.
  const outerWidth = Math.min(width, Math.max(200, (height - fh) * ratio + fw));
  return {width: Math.round(outerWidth), height: Math.round(height),
    left: Math.round(finite(size.left, 0) + (width - outerWidth) / 2),
    top: Math.round(finite(size.top, 0))};
}
