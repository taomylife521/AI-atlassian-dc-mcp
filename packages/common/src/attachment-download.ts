import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

/**
 * How the downloaded bytes should be returned to the caller inline, in addition
 * to (or instead of) being written to disk.
 * - `none`: do not embed the bytes in the response (default)
 * - `base64`: embed base64-encoded bytes (suitable for binary files)
 * - `text`: embed the bytes decoded as UTF-8 text (suitable for text files)
 */
export type AttachmentContentEncoding = 'none' | 'base64' | 'text';

/** Default cap for inline content so responses do not balloon. 1 MiB. */
export const DEFAULT_MAX_INLINE_BYTES = 1_048_576;

export interface AttachmentDownloadOptions {
  /** Explicit destination file path. Takes precedence over saveDir. */
  savePath?: string;
  /** Destination directory; the (sanitized) filename is appended to it. */
  saveDir?: string;
  /** Whether and how to embed the bytes in the response. Defaults to `none`. */
  returnContent?: AttachmentContentEncoding;
  /** Maximum bytes to embed inline when returnContent is not `none`. */
  maxInlineBytes?: number;
}

export interface AttachmentDownloadResult {
  filename: string;
  mediaType?: string;
  /** Number of bytes downloaded. */
  size: number;
  /** Absolute path the file was written to, when saving was requested. */
  savedPath?: string;
  /** Inline content, when returnContent is `base64` or `text`. */
  content?: string;
  encoding?: 'base64' | 'text';
  /** Set when inline content was requested but omitted (e.g. over the size cap). */
  contentOmittedReason?: string;
}

async function resolveToken(token: string | (() => string | undefined)): Promise<string> {
  const resolved = typeof token === 'function' ? token() : token;
  if (!resolved) {
    throw new Error('Missing API token for attachment download');
  }
  return resolved;
}

/**
 * Resolves a destination path for a downloaded file inside `saveDir`, guarding
 * against path traversal: only the basename of `filename` is used, and the
 * resolved path must stay within `saveDir`.
 */
export function resolveSafeChildPath(saveDir: string, filename: string): string {
  const safeName = basename(filename);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error(`Unsafe attachment filename: "${filename}"`);
  }
  const baseDir = resolve(saveDir);
  const target = resolve(baseDir, safeName);
  if (target !== baseDir && !target.startsWith(baseDir + sep)) {
    throw new Error(`Refusing to write outside of target directory: "${filename}"`);
  }
  return target;
}

function resolveDestination(filename: string, options: AttachmentDownloadOptions): string | undefined {
  if (options.savePath) {
    return isAbsolute(options.savePath) ? options.savePath : resolve(options.savePath);
  }
  if (options.saveDir) {
    return resolveSafeChildPath(options.saveDir, filename);
  }
  return undefined;
}

/**
 * Downloads a file from an authenticated Atlassian Data Center URL using a
 * Bearer token, optionally writing it to disk and/or returning its bytes inline.
 *
 * The bytes are buffered in memory; this is intended for typical attachment
 * sizes rather than very large files.
 */
export async function downloadAttachment(params: {
  url: string;
  token: string | (() => string | undefined);
  filename: string;
  mediaType?: string;
  options?: AttachmentDownloadOptions;
}): Promise<AttachmentDownloadResult> {
  const { url, filename, mediaType } = params;
  const options = params.options ?? {};
  const token = await resolveToken(params.token);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Attachment download endpoints are XSRF-protected; nocheck bypasses it.
      'X-Atlassian-Token': 'nocheck',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment "${filename}": ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const resolvedMediaType = mediaType ?? response.headers.get('content-type') ?? undefined;

  const result: AttachmentDownloadResult = {
    filename: basename(filename),
    mediaType: resolvedMediaType,
    size: buffer.length,
  };

  const destination = resolveDestination(filename, options);
  if (destination) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, buffer);
    result.savedPath = destination;
  }

  const returnContent = options.returnContent ?? 'none';
  if (returnContent !== 'none') {
    const cap = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
    if (buffer.length > cap) {
      result.contentOmittedReason = `File size ${buffer.length} bytes exceeds inline cap of ${cap} bytes`;
    } else {
      result.content = returnContent === 'base64' ? buffer.toString('base64') : buffer.toString('utf-8');
      result.encoding = returnContent;
    }
  }

  return result;
}
