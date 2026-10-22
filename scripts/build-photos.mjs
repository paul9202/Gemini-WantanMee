// 把演示识别图谱（3×3）切成独立 WebP 资产并生成显式 manifest。
// 图谱为生成的演示素材，不是档口实拍；正式营业前需替换为核对过的实拍图（reviewedBy 为 null 即未审核）。
// 用法：node scripts/build-photos.mjs
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const SOURCE = 'docs/claude-handoff/visuals/assets/food-atlas-v1.png';
const OUT_DIR = 'public/photos';
const MANIFEST = 'src/ui/photoManifest.json';
const VERSION = 1;
const SIZE = 360;

const CELLS = [
  ['dish.dry_noodle.red', '红酱干捞面'],
  ['dish.dry_noodle.black', '黑酱干捞面'],
  ['dish.dry_noodle.white', '白酱干捞面'],
  ['dish.soup_noodle', '云吞汤面'],
  ['dish.wanton_soup', '云吞汤'],
  ['dish.dry_wanton', '干捞云吞'],
  ['ingredient.char_siew', '叉烧'],
  ['noodle.thin_egg', '细面（生面团）'],
  ['noodle.mee_poh', '面薄（生面团）'],
];

const meta = await sharp(SOURCE).metadata();
const cell = Math.floor(meta.width / 3);
const inset = Math.round(cell * 0.04);
await mkdir(OUT_DIR, { recursive: true });
const manifest = [];
for (const [i, [photoId, altZh]] of CELLS.entries()) {
  const row = Math.floor(i / 3);
  const col = i % 3;
  const buf = await sharp(SOURCE)
    .extract({ left: col * cell + inset, top: row * cell + inset, width: cell - inset * 2, height: cell - inset * 2 })
    .resize(SIZE, SIZE)
    .webp({ quality: 80 })
    .toBuffer();
  const file = `${photoId}.v${VERSION}.webp`;
  await writeFile(`${OUT_DIR}/${file}`, buf);
  manifest.push({
    photoId, version: VERSION, path: `/photos/${file}`,
    hash: `sha256-${createHash('sha256').update(buf).digest('hex')}`,
    width: SIZE, height: SIZE, bytes: buf.length, altZh, source: 'generated-demo', reviewedBy: null,
  });
}
await writeFile(MANIFEST, JSON.stringify({ catalogVersion: `visual-v${VERSION}`, photos: manifest }, null, 2) + '\n');
console.log(`wrote ${manifest.length} photos, ${manifest.reduce((s, p) => s + p.bytes, 0)} bytes`);

// PWA 图标：番茄红底「豪」字印章（系统中文字体渲染）。
const iconSvg = (size) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#b93825"/>
  <text x="256" y="350" font-size="300" font-weight="900" text-anchor="middle" fill="#ffffff" font-family="Microsoft YaHei, Noto Sans SC, PingFang SC, sans-serif">豪</text>
</svg>`);
await mkdir('public/icons', { recursive: true });
for (const size of [192, 512]) await sharp(iconSvg(size)).png().toFile(`public/icons/icon-${size}.png`);
await sharp(iconSvg(180)).png().toFile('public/icons/apple-touch-icon.png');
console.log('wrote PWA icons');
