/**
 * 生成「开业前清空测试数据」确认码（店主 IC）的哈希，供写入 Secret Manager 的 STORE_RESET_CODE_HASH。
 * 原文不写文件、不进日志；终端里输入时不回显。用法（在 functions 目录）：
 *   npx tsx scripts/reset-code-hash.ts | npx firebase functions:secrets:set STORE_RESET_CODE_HASH --data-file=- --project wantan-staging
 * 设置后需要重新部署 resetStoreForOpeningCmd 才会用上新版本。
 */
import { hashResetCode, normalizeResetCode } from '../src/core/resetCode';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    stdin.on('data', (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    });
  });
}

async function readPiped(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

async function main() {
  const raw = process.stdin.isTTY ? await readHidden('输入店主 IC（不显示）：') : await readPiped();
  const code = normalizeResetCode(raw);
  if (!/^\d{12}$/.test(code)) {
    console.error('IC 应为 12 位数字（可带「-」）');
    process.exit(1);
  }
  process.stdout.write(hashResetCode(code));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
