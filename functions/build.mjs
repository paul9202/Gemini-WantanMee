// 把 functions/src 与共享的 ../src/domain 打包成单个 CJS 文件；
// firebase-admin / firebase-functions 保持外部依赖，由部署环境安装。
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*'],
  logLevel: 'info',
});
