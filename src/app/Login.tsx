import { FormEvent, useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth, USE_EMULATORS } from '../data/firebase/client';

/** 登录。老板正式环境优先 Google 登录（接真实项目时补）；员工为受邀账号，没有开放注册。 */
export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch {
      setError('账号或密码不正确，或网络不可用');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-2xl font-black text-white">豪</span>
          <div>
            <h1 className="text-2xl font-bold">豪云吞面</h1>
            <p className="text-sm text-ink-2">店内工作台登录</p>
          </div>
        </div>
        <label className="mb-1 block text-sm font-semibold" htmlFor="email">账号</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
          className="mb-4 h-12 w-full rounded-lg border border-control px-3 text-base" />
        <label className="mb-1 block text-sm font-semibold" htmlFor="password">密码</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          className="mb-4 h-12 w-full rounded-lg border border-control px-3 text-base" />
        {error && <p role="alert" className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <button disabled={busy} className="h-14 w-full rounded-xl bg-brand text-lg font-bold text-white hover:bg-brand-pressed disabled:opacity-60">
          {busy ? '正在登录…' : '登录'}
        </button>
        {USE_EMULATORS && <p className="mt-4 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn">本机测试环境（Emulator），数据不会进入真实云端。</p>}
      </form>
    </main>
  );
}
