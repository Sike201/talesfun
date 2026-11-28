/**
 * Exercise the real browser canvas path used by compressTokenImage.
 *   node scripts/test-compress-browser.mjs
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const MAX_UPLOAD = 3 * 1024 * 1024;
const MAX_COMPRESSED = 250 * 1024;
const MAX_DIM = 1280;

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, ".tmp-compress-test");
mkdirSync(outDir, { recursive: true });

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.log("… installing playwright chromium");
    const r = spawnSync(
      "npm",
      ["install", "--no-save", "playwright"],
      {
        cwd: join(__dirname, ".."),
        encoding: "utf8",
        shell: process.platform === "win32",
      }
    );
    if (r.status !== 0) {
      console.error(r.stderr || r.stdout);
      throw new Error("playwright install failed");
    }
    const r2 = spawnSync("npx", ["playwright", "install", "chromium"], {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (r2.status !== 0) {
      console.error(r2.stderr || r2.stdout);
      throw new Error("chromium install failed");
    }
    return await import("playwright");
  }
}

async function makeSourceJpeg() {
  const sharp = (await import("sharp")).default;
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
  const path = join(outDir, "browser-source.jpg");
  writeFileSync(path, buf);
  return { path, bytes: buf.length };
}

async function main() {
  const { path: srcPath, bytes: srcBytes } = await makeSourceJpeg();
  if (srcBytes > MAX_UPLOAD || srcBytes <= MAX_COMPRESSED) {
    throw new Error(`bad fixture size ${srcBytes}`);
  }
  console.log("source", (srcBytes / 1024).toFixed(1), "KB");

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Mirror compressTokenImage in the page (same algorithm / limits).
  await page.setContent(`<!doctype html><html><body></body></html>`);

  const result = await page.evaluate(
    async ({ srcBytesB64, fileName, MAX_COMPRESSED, MAX_DIM }) => {
      const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25];
      const binary = atob(srcBytesB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], fileName, { type: "image/jpeg" });

      const loadImage = file =>
        new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("load failed"));
          };
          img.src = url;
        });

      const img = await loadImage(file);
      let maxDim = MAX_DIM;
      const preferWebp = document
        .createElement("canvas")
        .toDataURL("image/webp")
        .startsWith("data:image/webp");

      const encode = async (canvas, type, quality) =>
        new Promise(resolve => canvas.toBlob(resolve, type, quality));

      for (let attempt = 0; attempt < 5; attempt++) {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);

        for (const type of [preferWebp ? "image/webp" : "image/jpeg", "image/jpeg"]) {
          for (const q of QUALITY_STEPS) {
            const blob = await encode(canvas, type, q);
            if (blob && blob.size <= MAX_COMPRESSED) {
              return {
                ok: true,
                size: blob.size,
                type: blob.type || type,
                width,
                height,
                quality: q,
              };
            }
          }
        }
        maxDim = Math.max(320, Math.round(maxDim * 0.7));
      }
      return { ok: false };
    },
    {
      srcBytesB64: readFileSync(srcPath).toString("base64"),
      fileName: "browser-source.jpg",
      MAX_COMPRESSED,
      MAX_DIM,
    }
  );

  await browser.close();

  if (!result.ok) throw new Error("browser compression failed to reach 250KB");
  if (result.size > MAX_COMPRESSED) {
    throw new Error(`browser result ${result.size} > 250KB`);
  }

  console.log(
    "✓ browser canvas compressed to",
    (result.size / 1024).toFixed(1),
    "KB",
    result.type,
    `${result.width}x${result.height}`,
    "q=",
    result.quality
  );
  console.log("All browser compress tests passed.");
}

main().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});
