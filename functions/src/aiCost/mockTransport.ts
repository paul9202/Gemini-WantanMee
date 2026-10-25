/**
 * 仅供 Emulator / 单元测试：模拟 Anthropic 与 DeepSeek 的 HTTP 响应，让真实适配器（请求构造、解析、主备切换）被完整执行。
 * 不是正式 AI 逻辑：文字按简单规则拆分，收据固定返回测试样例。config.ts 只在 Functions Emulator + demo- 项目里启用它。
 * 测试标记：原话含「#mock:claude-down」→ Claude 返回 529；「#mock:all-down」→ 两家都 503；「#mock:bad-json」→ Claude 返回不合结构的 JSON。
 */
const KEYWORDS: [RegExp, string][] = [
  [/煤气|gas/i, 'gas'], [/工资|薪/, 'wage'], [/租金|房租|rent/i, 'rent'], [/电费/, 'fridge_power'],
  [/肉碎|云吞皮|pork|wanton/i, 'wonton'], [/面薄|细面|面(?!包)|noodle/i, 'noodle'],
  [/葱|辣椒|叉烧|油渣|onion|chili/i, 'topping'], [/酱|油|盐|糖|味精|鸡精|骨|江鱼|鳊鱼|黄豆|sauce/i, 'seasoning'],
  [/清洁|维修|袋|包装|杂/, 'misc'],
];

const money = (n: string) => (Number(n).toFixed(2));

/** 「今天买了葱10块、肉碎32块、煤气35块，都付了」→ 三行。 */
export function mockExtractText(text: string) {
  const clean = text.replace(/#mock:[a-z-]+/g, '');
  const payment = /都付了|已付|付了|付清/.test(clean) ? 'paid' : /赊|欠|没付|未付|月底结/.test(clean) ? 'unpaid' : 'unknown';
  const lines = [];
  for (const seg of clean.split(/[，,、；;。\n]|和/)) {
    const m = /^(?:\s*(?:今天|昨天|刚才|早上)?\s*(?:买了|买|付了|交了)?)?\s*(.+?)\s*(?:(\d+(?:\.\d+)?)\s*(kg|公斤|包|瓶|粒|张))?\s*(?:RM|rm)?\s*(\d+(?:\.\d{1,2})?)\s*(?:块|令吉|元|ringgit)?\s*$/.exec(seg.trim());
    if (!m || !m[1] || /付|总共|一共/.test(m[1])) continue;
    const name = m[1].replace(/^(的|了)/, '').trim();
    if (!name) continue;
    lines.push({
      name, category: KEYWORDS.find(([re]) => re.test(name))?.[1] ?? 'unknown', amount: money(m[4]),
      quantity: m[2] ? m[2] : null, unit: m[3] ? (m[3] === '公斤' ? 'kg' : m[3]) : null, payment: null, evidence: seg.trim().slice(0, 60),
      personal_suggested: /洗发|零食|衣/.test(name), period_month: null,
    });
  }
  return {
    purchase_date: /昨天/.test(clean) ? 'YESTERDAY' : null, currency: 'MYR', payment, payment_source: null, supplier: null, receipt_number: null,
    discount: null, tax: null, printed_total: null, paid_amount: null, change: null, lines, warnings: lines.length ? [] : ['没有找到金额，请手动填写'],
  };
}

/** 测试收据：PASAR PAGI，葱 10、肉碎 35（印错）、番茄酱 12，折扣 2，合计 52，付 100 找 48。 */
export function mockExtractReceipt() {
  const line = (name: string, category: string, amount: string, quantity: string, unit: string) => ({ name, category, amount, quantity, unit, payment: null, evidence: `${name} ${amount}`, personal_suggested: false, period_month: null });
  return {
    purchase_date: null, currency: 'MYR', payment: 'paid', payment_source: null, supplier: 'PASAR PAGI（测试样例）', receipt_number: 'DEMO-1025-001',
    discount: '2.00', tax: '0.00', printed_total: '52.00', paid_amount: '100.00', change: '48.00',
    lines: [line('葱', 'topping', '10.00', '1', 'kg'), line('肉碎', 'wonton', '35.00', '2', 'kg'), line('番茄酱', 'seasoning', '12.00', '1', '瓶')],
    warnings: ['测试样例：模拟识别，不读取图片内容'],
  };
}

function mockExplain(userText: string) {
  const rows = [...userText.matchAll(/^(\S+) \| (\S+) \| (\S+) \| (.+?) \| RM(\d+\.\d{2}) \|/gm)].map((m) => ({ id: m[1], bucket: m[3], label: m[4], amount: m[5] }));
  if (!rows.length) return { summary: '这段时间还没有可解释的开销记录。', findings: [], limitations: ['没有记录'] };
  const top = [...rows].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
  return {
    summary: `（模拟解读）这段时间金额最大的一笔是「${top.label}」RM${top.amount}。`,
    findings: [{ text: `「${top.label}」RM${top.amount}，属于${top.bucket}。`, evidence_ids: [top.id] }],
    limitations: ['这是 Emulator 模拟解读，不是真实模型输出', '采购金额不等于实际消耗'],
  };
}

function today(userText: string, shift: number) {
  const d = /营业日 (\d{4}-\d{2}-\d{2})/.exec(userText)?.[1];
  if (!d) return null;
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + shift);
  return t.toISOString().slice(0, 10);
}

function respond(kind: 'extract' | 'explain', userText: string, hasImage: boolean) {
  if (kind === 'explain') return mockExplain(userText);
  if (hasImage) return mockExtractReceipt();
  const raw = /"""\n([\s\S]*?)\n"""/.exec(userText)?.[1] ?? userText;
  const r = mockExtractText(raw);
  return { ...r, purchase_date: r.purchase_date === 'YESTERDAY' ? today(userText, -1) : null };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createMockFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? '{}'));
    await new Promise((r) => setTimeout(r, 300));
    if (url.includes('/v1/messages')) {
      const content = body.messages?.[0]?.content as { type: string; text?: string }[];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (/#mock:(claude-down|all-down)/.test(text)) return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'mock overloaded' } });
      const kind = body.output_config?.format?.schema?.properties?.summary ? 'explain' : 'extract';
      const out = /#mock:bad-json/.test(text) ? { nope: true } : respond(kind, text, content.some((c) => c.type === 'image'));
      return json(200, { id: 'msg_mock', type: 'message', role: 'assistant', model: `${body.model}（模拟）`, content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } });
    }
    if (url.endsWith('/chat/completions')) {
      const user = body.messages?.[1]?.content;
      const text = typeof user === 'string' ? user : (user as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (/#mock:all-down/.test(text)) return json(503, { error: { message: 'mock unavailable' } });
      const kind = String(body.messages?.[0]?.content).includes('"summary"') ? 'explain' : 'extract';
      const out = respond(kind, text, typeof user !== 'string');
      return json(200, { id: 'cmpl_mock', model: `${body.model}（模拟）`, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(out) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
    }
    return json(404, { error: 'mock: unknown url' });
  }) as typeof fetch;
}
