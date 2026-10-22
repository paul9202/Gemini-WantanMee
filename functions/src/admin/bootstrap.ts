/**
 * 门店初始化（管理员用 Admin SDK 执行，不暴露为公开接口）：
 * 公开配置、老板配置、第一个 owner、1–50 号餐牌。演示/测试数据不在这里注入。
 */
import { Firestore } from 'firebase-admin/firestore';
import { BOM_V1 } from '../../../src/domain/bom';
import { DEFAULT_BUSINESS_DAY } from '../../../src/domain/businessDay';
import { DEFAULT_FIXED_COST } from '../../../src/domain/finance';
import { MENU_V1 } from '../../../src/domain/menu';
import { TOKEN_MAX, TOKEN_MIN } from '../../../src/domain/tokens';
import { storeRefs } from '../core/command';

export interface BootstrapOptions {
  storeId: string;
  name: string;
  ownerUid: string;
  ownerDisplayName: string;
  qrPayee: string | null;
}

export async function bootstrapStore(db: Firestore, opts: BootstrapOptions): Promise<{ created: boolean }> {
  const store = storeRefs(db, opts.storeId);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(store.configPublic);
    if (existing.exists) return { created: false };
    const now = Date.now();
    tx.create(store.configPublic, {
      name: opts.name, currency: 'MYR', timeZone: DEFAULT_BUSINESS_DAY.timeZone, cutoverMinutes: DEFAULT_BUSINESS_DAY.cutoverMinutes,
      activeMenuVersion: MENU_V1.version, activeBomVersion: BOM_V1.version, activeRegisterId: null, qrPayee: opts.qrPayee, createdAtMs: now,
    });
    tx.create(store.configFinance, {
      initialCapitalSen: 550_000, openingProfitSen: 0, fixedCostPolicy: DEFAULT_FIXED_COST, createdAtMs: now,
    });
    tx.create(store.member(opts.ownerUid), { role: 'owner', active: true, displayName: opts.ownerDisplayName, updatedAtMs: now, updatedBy: 'bootstrap' });
    for (let n = TOKEN_MIN; n <= TOKEN_MAX; n++) {
      tx.create(store.token(n), { number: n, state: 'available', orderId: null, version: 0, updatedAtMs: now });
    }
    return { created: true };
  });
}
