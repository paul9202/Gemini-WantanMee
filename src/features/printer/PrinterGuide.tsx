/**
 * 送餐单打印机连接说明（给老板看）：准备什么、第一次怎么连、每天开店做什么、页头状态、出问题怎么办。
 * 从「设置 → 送餐单打印 → 连接说明」和打印机面板打开；总开关关着也能看（打印机到货前先读）。随版本打包，断网也能看。
 */
import { ReactNode } from 'react';

export function PrinterGuideDialog({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="送餐单打印机连接说明" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-card shadow-xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2 className="flex-1 text-xl font-bold">送餐单打印机 · 连接说明</h2>
          <button type="button" onClick={onClose} autoFocus className="h-12 rounded-xl border border-line px-4 font-semibold">关闭</button>
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 text-[15px] leading-relaxed">
          <p className="text-ink-2">
            每下一单，出餐口的打印机就打一张送餐单：几号牌、堂食还是打包、每碗是什么、每行金额和合计。送面的人照着纸单对号送。
            纸单上的金额是<b className="text-ink">订单金额</b>，客人付没付看后厨卡片（已付会写「已付 · 不用收」）。
          </p>

          <Part title="一、先准备好">
            <Check>打印机：80mm 热敏打印机，蓝牙要是 <b>BLE（4.0 或以上）</b>，最好有自动切刀、插电用的台式机。</Check>
            <Check>主收银平板：用 <b>Chrome</b> 打开点餐系统（或从桌面图标打开）。iPad、iPhone 连不了。</Check>
            <Check>热敏纸：照打印机说明书装好纸卷。</Check>
            <Check>位置：打印机放在出餐口，插电开机；离收银平板 10 米以内。不要放在煮面炉旁边（热敏纸遇热会变黑），也不要挡在不锈钢柜后面。</Check>
          </Part>

          <Part title="二、第一次连接（大约 5 分钟）">
            <Step n={1}>老板：<Path>设置 → 送餐单打印</Path> → 打开开关。</Step>
            <Step n={2}>主收银平板：打开平板的<b>蓝牙</b>。不用在平板的系统设置里配对打印机，直接在点餐系统里连。</Step>
            <Step n={3}>主收银平板：<Path>设备 → 送餐单打印机 → 连接</Path> → 按「连接蓝牙打印机」。</Step>
            <Step n={4}>弹出的列表里选打印机的名字（常见的像 Printer001、XP-xxxx、BlueTooth Printer），按「配对」或「连接」。Chrome 第一次会问能不能使用附近的设备，选<b>允许</b>。</Step>
            <Step n={5}>
              连上后按「测试打印」，到出餐口看测试条：
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>中文清楚 → 打印机有中文字库</li>
                <li>底下自动切开 → 切刀正常</li>
                <li>出餐口收得到 → 蓝牙距离够</li>
              </ul>
            </Step>
            <Step n={6}>回到点餐页：页头「后厨已连接」旁边出现绿色「打印机」。下一单试试，出餐口会打出送餐单，下单结果里多一步「✓ 已打印」。</Step>
          </Part>

          <Part title="三、每天开店">
            <Check>先开打印机，再打开收银平板的点餐页。</Check>
            <Check>页头是橙色「点一下连接打印机」就点一下（页面重新打开后，Chrome 规定要人手点一次）。</Check>
            <Check>看一眼纸卷还够不够。</Check>
          </Part>

          <Part title="四、页头的打印机状态">
            <Status tone="ok" text="打印机">正常，下单就打。</Status>
            <Status tone="ok" text="正在打 12 号…">正在打印。</Status>
            <Status tone="warn" text="点一下连接打印机">点一下就连上。</Status>
            <Status tone="bad" text="打印机断开 · 2 张待打">打印机没电、关了或太远。开回来会自动补打断开 10 分钟以内的单，更早的交给收银决定。</Status>
            <Status tone="bad" text="1 张没打出来">点开打印机面板，逐张按「补打」或「不打了」。</Status>
            <p className="text-sm text-ink-2">打印机没连、断开、没纸，都不影响下单；后厨屏照常收单。</p>
          </Part>

          <Part title="五、遇到问题">
            <Faq q="列表里找不到打印机">打印机开着吗？是不是被别的手机连着？一台打印机同时只能连一台设备：先断开别的，或关掉打印机再开。还是找不到，多半是打印机只有旧式蓝牙（不是 BLE），要换一台。</Faq>
            <Faq q="提示「选的设备不是打印机，或不支持 BLE」">选错了设备，或打印机不是 BLE 蓝牙。</Faq>
            <Faq q="测试条上的中文变成问号或乱码">打印机没有中文字库。先别打开使用，联系开发改成图片打印。</Faq>
            <Faq q="打出半张、或一堆乱码">在打印机面板里补打这一张。经常这样就联系开发，把传输调慢一点。</Faq>
            <Faq q="缺纸了平板没提示">便宜的打印机多数不会告诉平板缺纸。跟员工说好：没看到纸单就看后厨屏。</Faq>
            <Faq q="换了主收银平板">旧平板：打开打印机面板按「断开」（或关掉打印机再开）。新平板：照「第一次连接」第 3–5 步。</Faq>
            <Faq q="暂时不想用">全店停用：<Path>设置 → 送餐单打印</Path> 关掉，所有平板都不再打印。只停一台设备：打印机面板最下面「这台设备不用打印机了」。</Faq>
          </Part>
        </div>
      </div>
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-lg font-bold">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-line p-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink font-bold text-white">{n}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Check({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span aria-hidden className="mt-0.5 font-bold text-ok">✓</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Path({ children }: { children: ReactNode }) {
  return <b className="rounded-md bg-subtle px-1.5 py-0.5">{children}</b>;
}

const TONES = { ok: 'bg-ok-bg text-ok', warn: 'bg-warn-bg text-warn', bad: 'bg-danger-bg text-danger' } as const;

function Status({ tone, text, children }: { tone: keyof typeof TONES; text: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] font-semibold ${TONES[tone]}`}><span className="h-2 w-2 rounded-full bg-current" />{text}</span>
      <span className="min-w-[200px] flex-1 text-sm">{children}</span>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-subtle p-3">
      <b className="block">{q}</b>
      <span className="text-sm">{children}</span>
    </div>
  );
}
