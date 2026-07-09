import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadAttachment, resolveSafeChildPath } from '../attachment-download.js';

function mockFetchOnce(body: Buffer, init?: { ok?: boolean; status?: number; statusText?: string; contentType?: string }) {
  const ok = init?.ok ?? true;
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    statusText: init?.statusText ?? (ok ? 'OK' : 'Error'),
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? init?.contentType ?? null : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }) as unknown as typeof fetch;
}

describe('resolveSafeChildPath', () => {
  it('joins the basename of the filename to the directory', () => {
    expect(resolveSafeChildPath('/tmp/out', 'file.txt')).toBe(path.resolve('/tmp/out', 'file.txt'));
  });

  it('strips directory components from the filename (traversal defense)', () => {
    expect(resolveSafeChildPath('/tmp/out', '../../etc/passwd')).toBe(path.resolve('/tmp/out', 'passwd'));
    expect(resolveSafeChildPath('/tmp/out', '/etc/passwd')).toBe(path.resolve('/tmp/out', 'passwd'));
  });

  it('rejects filenames that resolve to the directory itself', () => {
    expect(() => resolveSafeChildPath('/tmp/out', '..')).toThrow();
    expect(() => resolveSafeChildPath('/tmp/out', '.')).toThrow();
  });
});

describe('downloadAttachment', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mcp-dl-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('saves the file to saveDir using the filename and reports metadata', async () => {
    mockFetchOnce(Buffer.from('hello world'), { contentType: 'text/plain' });

    const result = await downloadAttachment({
      url: 'https://host/download/x',
      token: 'tok',
      filename: 'note.txt',
      options: { saveDir: tmpDir },
    });

    expect(global.fetch).toHaveBeenCalledWith('https://host/download/x', {
      headers: { Authorization: 'Bearer tok', 'X-Atlassian-Token': 'nocheck' },
    });
    expect(result.savedPath).toBe(path.join(tmpDir, 'note.txt'));
    expect(result.size).toBe(11);
    expect(fs.readFileSync(result.savedPath!, 'utf-8')).toBe('hello world');
    expect(result.content).toBeUndefined();
  });

  it('returns text content inline when requested', async () => {
    mockFetchOnce(Buffer.from('inline text'));

    const result = await downloadAttachment({
      url: 'https://host/download/x',
      token: () => 'tok',
      filename: 'note.txt',
      options: { returnContent: 'text' },
    });

    expect(result.content).toBe('inline text');
    expect(result.encoding).toBe('text');
    expect(result.savedPath).toBeUndefined();
  });

  it('returns base64 content inline when requested', async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    mockFetchOnce(bytes);

    const result = await downloadAttachment({
      url: 'https://host/download/x',
      token: 'tok',
      filename: 'blob.bin',
      options: { returnContent: 'base64' },
    });

    expect(result.content).toBe(bytes.toString('base64'));
    expect(result.encoding).toBe('base64');
  });

  it('omits inline content when the file exceeds maxInlineBytes', async () => {
    mockFetchOnce(Buffer.from('123456'));

    const result = await downloadAttachment({
      url: 'https://host/download/x',
      token: 'tok',
      filename: 'big.txt',
      options: { returnContent: 'text', maxInlineBytes: 3 },
    });

    expect(result.content).toBeUndefined();
    expect(result.contentOmittedReason).toContain('exceeds inline cap');
  });

  it('throws when the response is not ok', async () => {
    mockFetchOnce(Buffer.from(''), { ok: false, status: 404, statusText: 'Not Found' });

    await expect(
      downloadAttachment({ url: 'https://host/x', token: 'tok', filename: 'f.txt' }),
    ).rejects.toThrow('404 Not Found');
  });

  it('throws when no token is available', async () => {
    mockFetchOnce(Buffer.from(''));

    await expect(
      downloadAttachment({ url: 'https://host/x', token: () => undefined, filename: 'f.txt' }),
    ).rejects.toThrow('Missing API token');
  });
});
