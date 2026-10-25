/**
 * 私有收据图片：只接受本店草稿目录下、由老板上传的 JPEG / PNG / WebP（≤10 MB，最多 5 张）。
 * - 不接受任意 URL，不生成公开下载链接；服务端按对象路径 + generation 读取，校验文件签名与 SHA-256。
 * - Storage Rules 禁止覆盖已上传对象；识别时再按冻结的 generation 读取，原图被替换也读不到新内容。
 */
import { createHash } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { MAX_RECEIPT_BYTES, ReceiptMime } from '../../../src/domain/aiCost';
import { CommandError } from '../core/errors';
import type { ImageInput } from './types';

export interface Attachment { path: string; generation: string; mime: ReceiptMime; bytes: number; sha256: string }

export const uploadPrefix = (storeId: string, draftId: string) => `stores/${storeId}/ai-cost-drafts/${draftId}/`;
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const EXT_MIME: Record<string, ReceiptMime> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** 按文件头判断真实格式（不信扩展名与声明的 contentType）。 */
export function sniffImage(b: Uint8Array): ReceiptMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

const reject = (msg: string) => new CommandError('ATTACHMENT_REJECTED', msg);

export function checkAttachmentPath(storeId: string, draftId: string, path: string): ReceiptMime {
  const prefix = uploadPrefix(storeId, draftId);
  if (typeof path !== 'string' || !path.startsWith(prefix)) throw reject('图片不在这份草稿的上传目录');
  const m = NAME.exec(path.slice(prefix.length));
  if (!m) throw reject('图片文件名不合规定');
  return EXT_MIME[m[1]];
}

/** 校验刚上传的对象：路径、大小、声明类型、真实文件签名一致；返回冻结后的清单项。 */
export async function inspectUpload(storeId: string, draftId: string, path: string): Promise<Attachment> {
  const extMime = checkAttachmentPath(storeId, draftId, path);
  const file = getStorage().bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) throw reject('找不到上传的图片，请重新上传');
  const [meta] = await file.getMetadata();
  const size = Number(meta.size);
  if (!(size > 0) || size > MAX_RECEIPT_BYTES) throw reject('每张图片最大 10 MB');
  if (meta.contentType !== extMime) throw reject('图片类型与文件不符');
  const [bytes] = await file.download();
  const real = sniffImage(bytes);
  if (real !== extMime) throw reject('只支持 JPEG / PNG / WebP 图片（HEIC、PDF 请先转换）');
  return { path, generation: String(meta.generation), mime: real, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** 识别时读取：按 generation 读取并核对 hash，保证模型看到的就是冻结时的原图。 */
export async function loadImages(attachments: Attachment[]): Promise<ImageInput[]> {
  const bucket = getStorage().bucket();
  return Promise.all(attachments.map(async (a) => {
    const [bytes] = await bucket.file(a.path, { generation: Number(a.generation) }).download();
    if (createHash('sha256').update(bytes).digest('hex') !== a.sha256 || sniffImage(bytes) !== a.mime) throw reject('图片已变化，请重新上传');
    return { mime: a.mime, base64: bytes.toString('base64'), bytes: bytes.length };
  }));
}

export async function deleteAttachments(paths: string[]) {
  const bucket = getStorage().bucket();
  await Promise.all(paths.map((p) => bucket.file(p).delete({ ignoreNotFound: true }).catch(() => undefined)));
}
