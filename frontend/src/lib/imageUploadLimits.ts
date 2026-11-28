/** Max size for the file the user selects (before compression). */
export const MAX_IMAGE_UPLOAD_BYTES = 3 * 1024 * 1024;

/** Max size of the file we store / send to Pinata. */
export const MAX_COMPRESSED_IMAGE_BYTES = 250 * 1024;

/** Longest edge after resize. */
export const MAX_IMAGE_DIMENSION = 1280;

/** Animated / non-still image types we never accept. */
export const BLOCKED_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/apng",
] as const;

const BLOCKED_SET = new Set<string>(BLOCKED_IMAGE_MIME_TYPES);

/**
 * Still images only: any `image/*` MIME except animated formats (GIF / APNG).
 * PNG, JPEG, WebP, AVIF, BMP, TIFF, HEIC, etc. are fine.
 */
export function isAllowedTokenImageType(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const t = mime.toLowerCase().trim();
  if (!t.startsWith("image/")) return false;
  if (BLOCKED_SET.has(t)) return false;
  return true;
}

export const IMAGE_TYPE_ERROR =
  "Still images only — GIF and other animated formats are not allowed";

/**
 * Prefer common still formats in the picker; GIF is omitted on purpose.
 * Runtime still validates via `isAllowedTokenImageType`.
 */
export const IMAGE_FILE_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
].join(",");
