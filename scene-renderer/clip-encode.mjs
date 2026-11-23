// Animated clip encoding (Node-only: uses sharp).
//
// Frames arrive as PNG buffers (one per frame, all the same size — the
// existing per-frame capture path). They are decoded to raw RGBA, stacked
// vertically, and encoded as one animated WebP (looping forever, one delay
// per frame). sharp's animated-WebP path (stacked frames + pageHeight) is
// documented and was verified against sharp 0.35.5: the output decodes
// with the right page count, loop: 0, and per-frame delays.
//
// sharp is imported lazily inside encodeClip, never at module top level:
// a missing or broken sharp must fail clip requests with a clear error,
// not kill the whole service at startup — stills do not need sharp.
export async function encodeClip(frames, { width, height, fps, quality = 80 }) {
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new Error(`encodeClip needs at least 2 frames, got ${frames?.length ?? 0}`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodeClip needs a valid frame size, got ${width}x${height}`);
  }
  let sharp;
  try {
    ({ default: sharp } = await import("sharp"));
  } catch (err) {
    throw new Error(
      `clip encoding needs the sharp module, which failed to load: ${err.message}`,
    );
  }
  const delayMs = Math.max(10, Math.round(1000 / fps));
  // One delay per frame: a single number applies only to the first frame
  // (later frames fall back to 100 ms — observed with sharp 0.35.5).
  const delays = Array(frames.length).fill(delayMs);
  const rawFrames = [];
  for (let i = 0; i < frames.length; i += 1) {
    const { data, info } = await sharp(frames[i])
      .ensureAlpha() // PNGs may be RGB or RGBA; normalize to 4 channels
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 4) {
      throw new Error(
        `clip frame ${i} is ${info.width}x${info.height}x${info.channels}, expected ${width}x${height}x4`,
      );
    }
    rawFrames.push(data);
  }
  const stacked = Buffer.concat(rawFrames);
  return sharp(stacked, {
    raw: { width, height: height * frames.length, channels: 4, pageHeight: height },
  })
    .webp({ quality, loop: 0, delay: delays, effort: 4 })
    .toBuffer();
}
