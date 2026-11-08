import { test } from "node:test";
import assert from "node:assert/strict";
import { fitScale, resize, encodePng, decodePng, encodeJpeg, MAX_EDGE, MAX_PIXELS } from "../../src/image.js";

function solid(w, h, rgba) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

test("fitScale keeps images within Claude's vision limits", () => {
  assert.equal(fitScale(1280, 800), 1);
  for (const [w, h] of [[2880, 1800], [1920, 1080], [3840, 2160], [800, 6000]]) {
    const s = fitScale(w, h);
    assert.ok(Math.max(w, h) * s <= MAX_EDGE + 1e-6);
    assert.ok(w * h * s * s <= MAX_PIXELS + 1);
  }
});

test("area-average downscale", () => {
  const img = { width: 2, height: 2, data: Buffer.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]) };
  const out = resize(img, 1, 1);
  assert.deepEqual([...out.data], [100, 100, 100, 255]);
  const big = resize(solid(300, 200, [10, 20, 30, 255]), 123, 77);
  assert.equal(big.width, 123);
  assert.equal(big.height, 77);
  assert.deepEqual([...big.data.subarray(0, 4)], [10, 20, 30, 255]);
});

test("png round trip and jpeg encode", () => {
  const img = solid(16, 9, [255, 0, 0, 255]);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 16);
  assert.deepEqual([...back.data.subarray(0, 4)], [255, 0, 0, 255]);
  const jpg = encodeJpeg(img, 80);
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);
});
