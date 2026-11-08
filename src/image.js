// Image helpers: PNG decode, high quality downscale, JPEG/PNG encode.

import { PNG } from "pngjs";
import jpeg from "jpeg-js";

// Claude's vision input: keep the long edge ≤ 1568px and ≤ ~1.15MP so images
// are not resized again on the API side (which would break coordinate math).
export const MAX_EDGE = 1568;
export const MAX_PIXELS = 1_150_000;

export function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy ? img.data.copy(png.data) : png.data.set(img.data);
  return PNG.sync.write(png, { colorType: 6 });
}

export function encodeJpeg(img, quality = 80) {
  return jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data;
}

/** Scale factor (≤ 1) that fits w×h inside Claude's recommended image size. */
export function fitScale(w, h, maxEdge = MAX_EDGE, maxPixels = MAX_PIXELS) {
  if (!(w > 0 && h > 0)) return 1;
  return Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
}

function weights(srcLen, dstLen) {
  // For each destination index, the list of [srcIndex, weight] covering it.
  const ratio = srcLen / dstLen;
  const out = new Array(dstLen);
  for (let d = 0; d < dstLen; d++) {
    const start = d * ratio;
    const end = start + ratio;
    const list = [];
    let s = Math.floor(start);
    while (s < end && s < srcLen) {
      const w = Math.min(end, s + 1) - Math.max(start, s);
      if (w > 1e-6) list.push(s, w / ratio);
      s++;
    }
    out[d] = list;
  }
  return out;
}

/** Area-averaging resize (downscale) of an RGBA image. Upscaling uses nearest neighbour. */
export function resize(img, width, height) {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  if (width === img.width && height === img.height) return img;
  const { width: sw, height: sh, data: src } = img;

  if (width > sw || height > sh) {
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(sw - 1, Math.floor((x * sw) / width));
        const si = (sy * sw + sx) * 4;
        const di = (y * width + x) * 4;
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = src[si + 3];
      }
    }
    return { width, height, data: out };
  }

  // Horizontal pass: sw×sh → width×sh
  const wx = weights(sw, width);
  const tmp = new Float32Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    const trow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const list = wx[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < list.length; i += 2) {
        const si = row + list[i] * 4;
        const w = list[i + 1];
        r += src[si] * w;
        g += src[si + 1] * w;
        b += src[si + 2] * w;
        a += src[si + 3] * w;
      }
      const ti = trow + x * 4;
      tmp[ti] = r;
      tmp[ti + 1] = g;
      tmp[ti + 2] = b;
      tmp[ti + 3] = a;
    }
  }
  // Vertical pass: width×sh → width×height
  const wy = weights(sh, height);
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const list = wy[y];
    const drow = y * width * 4;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < list.length; i += 2) {
        const ti = (list[i] * width + x) * 4;
        const w = list[i + 1];
        r += tmp[ti] * w;
        g += tmp[ti + 1] * w;
        b += tmp[ti + 2] * w;
        a += tmp[ti + 3] * w;
      }
      const di = drow + x * 4;
      out[di] = r + 0.5;
      out[di + 1] = g + 0.5;
      out[di + 2] = b + 0.5;
      out[di + 3] = a + 0.5;
    }
  }
  return { width, height, data: out };
}

/** Draw a filled circle with a white outline (used to mark clicks in GIFs). */
export function drawMarker(img, cx, cy, radius = 9, color = [233, 84, 32]) {
  const { width, height, data } = img;
  const r2 = radius * radius;
  const o2 = (radius + 2) * (radius + 2);
  for (let y = Math.max(0, Math.floor(cy - radius - 2)); y <= Math.min(height - 1, Math.ceil(cy + radius + 2)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 2)); x <= Math.min(width - 1, Math.ceil(cx + radius + 2)); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 > o2) continue;
      const i = (y * width + x) * 4;
      const c = d2 <= r2 ? color : [255, 255, 255];
      const alpha = d2 <= r2 ? 0.75 : 1;
      data[i] = data[i] * (1 - alpha) + c[0] * alpha;
      data[i + 1] = data[i + 1] * (1 - alpha) + c[1] * alpha;
      data[i + 2] = data[i + 2] * (1 - alpha) + c[2] * alpha;
      data[i + 3] = 255;
    }
  }
}
