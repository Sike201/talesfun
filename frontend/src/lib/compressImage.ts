export {
  IMAGE_FILE_ACCEPT,
  IMAGE_TYPE_ERROR,
  MAX_COMPRESSED_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_UPLOAD_BYTES,
  isAllowedTokenImageType,
} from "@/lib/imageUploadLimits";
import {
  IMAGE_TYPE_ERROR,
  MAX_COMPRESSED_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_UPLOAD_BYTES,
  isAllowedTokenImageType,
} from "@/lib/imageUploadLimits";

const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25];

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

function drawToCanvas(
  img: HTMLImageElement,
  maxDimension: number
): HTMLCanvasElement {
  const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), type, quality);
  });
}

function baseName(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i > 0 ? fileName.slice(0, i) : fileName || "token-image";
}

async function encodeJpegUnderLimit(
  canvas: HTMLCanvasElement
): Promise<{ blob: Blob; type: string } | null> {
  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (blob && blob.size <= MAX_COMPRESSED_IMAGE_BYTES) {
      return { blob, type: "image/jpeg" };
    }
  }
  return null;
}

/**
 * Resize + re-encode a still image so the result is ≤ 250KB (JPEG).
 * Animated formats (GIF / APNG) are rejected. Files already ≤ 250KB are returned unchanged.
 */
export async function compressTokenImage(file: File): Promise<File> {
  if (!(file instanceof File) || file.size <= 0) {
    throw new Error("No image selected");
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Image must be under 3MB");
  }
  if (!isAllowedTokenImageType(file.type)) {
    throw new Error(IMAGE_TYPE_ERROR);
  }

  if (file.size <= MAX_COMPRESSED_IMAGE_BYTES) {
    return file;
  }

  const img = await loadImage(file);
  let maxDim = MAX_IMAGE_DIMENSION;
  const stem = baseName(file.name);

  for (let attempt = 0; attempt < 5; attempt++) {
    const canvas = drawToCanvas(img, maxDim);
    const encoded = await encodeJpegUnderLimit(canvas);
    if (encoded) {
      return new File([encoded.blob], `${stem}.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
    }
    maxDim = Math.max(320, Math.round(maxDim * 0.7));
  }

  throw new Error("Could not compress image under 250KB — try a simpler image");
}
