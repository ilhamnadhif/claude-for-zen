// Incremental GIF recording of browser actions.

import gifenc from "gifenc";

const { GIFEncoder, quantize, applyPalette } = gifenc;
import { resize, drawMarker } from "./image.js";

export const GIF_MAX_WIDTH = 800;
export const GIF_MAX_FRAMES = 200;

export class GifRecording {
  constructor() {
    this.encoder = GIFEncoder();
    this.width = 0;
    this.height = 0;
    this.frames = 0;
    this.last = null;
    this.recording = true;
    this.startedAt = Date.now();
    this.dropped = 0;
  }

  /**
   * Add an RGBA frame. `marker` is an optional {x, y} in the frame's own pixels.
   */
  addFrame(img, { marker, delayMs = 700 } = {}) {
    if (this.frames >= GIF_MAX_FRAMES) {
      this.dropped++;
      return false;
    }
    if (!this.width) {
      const s = Math.min(1, GIF_MAX_WIDTH / img.width);
      this.width = Math.max(1, Math.round(img.width * s));
      this.height = Math.max(1, Math.round(img.height * s));
    }
    const sx = this.width / img.width;
    const sy = this.height / img.height;
    let frame = resize(img, this.width, this.height);
    if (frame === img) frame = { width: img.width, height: img.height, data: Buffer.from(img.data) };
    if (marker) drawMarker(frame, marker.x * sx, marker.y * sy);
    const palette = quantize(frame.data, 256);
    const index = applyPalette(frame.data, palette);
    this.encoder.writeFrame(index, this.width, this.height, { palette, delay: delayMs });
    this.last = { index, palette };
    this.frames++;
    return true;
  }

  /** Finish and return the GIF bytes (the last frame is held a little longer). */
  finish() {
    if (this.last) {
      this.encoder.writeFrame(this.last.index, this.width, this.height, { palette: this.last.palette, delay: 1500 });
    }
    this.encoder.finish();
    return Buffer.from(this.encoder.bytes());
  }
}
