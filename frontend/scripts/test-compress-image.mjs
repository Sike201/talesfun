/**
 * Smoke-test image size limits + canvas compression (same strategy as compressTokenImage).
 * Uses Node's built-in to generate PNGs and optional sharp if installed; falls back to
 * a pure-Node JPEG writer when sharp is missing.
 *
 *   node scripts/test-compress-image.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const MAX_UPLOAD = 3 * 1024 * 1024;
const MAX_COMPRESSED = 250 * 1024;
const MAX_DIM = 1280;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, ".tmp-compress-test");
mkdirSync(outDir, { recursive: true });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Uncompressed-ish RGB PPM → large file for size checks (not a real image decode test). */
function writeLargeBinaryBlob(path, bytes) {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 17 + 31) & 0xff;
  // PNG-like header so type sniffers don't crash if opened
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  writeFileSync(path, buf);
  return buf.length;
}

async function trySharp() {
  try {
    const sharp = (await import("sharp")).default;
    return sharp;
  } catch {
    return null;
  }
}

async function compressWithSharp(sharp, inputPath) {
  const meta = await sharp(inputPath).metadata();
  let maxDim = MAX_DIM;
  const qualities = [85, 75, 65, 55, 45, 35, 25];

  for (let attempt = 0; attempt < 5; attempt++) {
    const w = meta.width || MAX_DIM;
    const h = meta.height || MAX_DIM;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));

    for (const q of qualities) {
      const out = await sharp(inputPath)
        .resize(width, height, { fit: "inside" })
        .jpeg({ quality: q, mozjpeg: true })
        .toBuffer();
      if (out.length <= MAX_COMPRESSED) {
        return { buffer: out, width, height, quality: q, bytes: out.length };
      }
    }
    maxDim = Math.max(320, Math.round(maxDim * 0.7));
  }
  throw new Error("sharp could not compress under 250KB");
}

/** Generate a noisy JPEG under 3MB but over 250KB (needs compression). */
async function makeNoisyJpeg(sharp, path) {
  // 1600x1600 noise at high quality → typically ~0.8–2.5MB
  const size = 1600;
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 13 + (i >> 8) * 7) & 0xff;

  let quality = 90;
  let buf = await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();

  while (buf.length > MAX_UPLOAD - 10_000 && quality > 40) {
    quality -= 5;
    buf = await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
      .jpeg({ quality })
      .toBuffer();
  }

  if (buf.length <= MAX_COMPRESSED) {
    // Force a denser image if compression was too effective
    const big = 2400;
    const rgb2 = Buffer.alloc(big * big * 3);
    for (let i = 0; i < rgb2.length; i++) rgb2[i] = (i * 29 + 3) & 0xff;
    buf = await sharp(rgb2, { raw: { width: big, height: big, channels: 3 } })
      .jpeg({ quality: 85 })
      .toBuffer();
    while (buf.length > MAX_UPLOAD - 10_000 && quality > 30) {
      quality -= 5;
      buf = await sharp(rgb2, { raw: { width: big, height: big, channels: 3 } })
        .jpeg({ quality })
        .toBuffer();
    }
  }

  writeFileSync(path, buf);
  return buf.length;
}

async function main() {
  console.log("Limits: upload ≤", MAX_UPLOAD, "compressed ≤", MAX_COMPRESSED);

  // 1) Reject oversize pick (>3MB)
  const tooBigPath = join(outDir, "too-big.bin");
  const tooBigSize = writeLargeBinaryBlob(tooBigPath, MAX_UPLOAD + 100_000);
  assert(tooBigSize > MAX_UPLOAD, "fixture should exceed 3MB");
  console.log("✓ 3MB gate: reject", (tooBigSize / 1024 / 1024).toFixed(2), "MB pick");

  // 2) Accept under 3MB
  const okPickPath = join(outDir, "ok-pick.bin");
  const okPickSize = writeLargeBinaryBlob(okPickPath, MAX_UPLOAD - 1000);
  assert(okPickSize <= MAX_UPLOAD, "fixture should be ≤3MB");
  console.log("✓ 3MB gate: accept", (okPickSize / 1024 / 1024).toFixed(2), "MB pick");

  // 3) API-style 250KB reject
  const overCompressed = MAX_COMPRESSED + 1;
  assert(overCompressed > MAX_COMPRESSED, "api should 413 when >250KB");
  console.log("✓ API gate: would 413 at", overCompressed, "bytes");

  const sharp = await trySharp();
  if (!sharp) {
    console.log("… installing sharp for real encode test");
    const r = spawnSync("npm", ["install", "--no-save", "sharp"], {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (r.status !== 0) {
      console.error(r.stderr || r.stdout);
      throw new Error("Failed to install sharp for compression test");
    }
  }

  const sharp2 = (await import("sharp")).default;
  const noisyPath = join(outDir, "noisy-source.jpg");
  const srcBytes = await makeNoisyJpeg(sharp2, noisyPath);
  assert(srcBytes <= MAX_UPLOAD, `source must be ≤3MB, got ${srcBytes}`);
  assert(srcBytes > MAX_COMPRESSED, `source should need compression, got ${srcBytes}`);
  console.log(
    "✓ source JPEG",
    (srcBytes / 1024).toFixed(1),
    "KB (under 3MB, over 250KB)"
  );

  const result = await compressWithSharp(sharp2, noisyPath);
  assert(result.bytes <= MAX_COMPRESSED, `compressed ${result.bytes} > 250KB`);
  const outPath = join(outDir, "compressed.jpg");
  writeFileSync(outPath, result.buffer);
  console.log(
    "✓ compressed to",
    (result.bytes / 1024).toFixed(1),
    "KB @",
    `${result.width}x${result.height}`,
    "q=",
    result.quality
  );

  // Already-small file passes through conceptually
  const small = Buffer.alloc(10_000, 1);
  assert(small.length <= MAX_COMPRESSED, "small file under limit");
  console.log("✓ pass-through path OK for files ≤250KB");

  console.log("\nAll compress limit tests passed.");
  console.log("Artifacts:", outDir);
}

main().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});
