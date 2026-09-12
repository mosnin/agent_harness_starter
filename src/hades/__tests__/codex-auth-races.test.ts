import { expect, it, vi } from 'vitest';
import { CodexProvider } from '../models/codex-provider';
// Protocol-only harness: no binary, keychain, browser, credentials or network.
function fixture() {
  const events: unknown[] = [];
  const provider = new CodexProvider('/unused-auth-fixture', e => events.push(e));
  const p = provider as any;
  vi.spyOn(p, 'start').mockResolvedValue(undefined);
  const request = vi.spyOn(p, 'request');
  return { provider, p, events, request };
}
it('coalesces concurrent sign-in and cancels a late start without returning a browser URL', async () => {
  const f = fixture(); let finish!: (v: unknown) => void;
  f.request.mockImplementation(async (method: unknown) => method === 'account/login/start'
    ? new Promise(r => { finish = r; }) : {});
  const first = f.provider.login(), second = f.provider.login();
  const checks = Promise.all([expect(first).rejects.toThrow(/cancelled/), expect(second).rejects.toThrow(/cancelled/)]);
  await Promise.resolve();
  await f.provider.cancelLogin();
  finish({loginId:'late',authUrl:'https://auth.openai.com/authorize'});
  await checks;
  expect(f.request.mock.calls.filter(([m]) => m === 'account/login/start')).toHaveLength(1);
  expect(f.request).toHaveBeenCalledWith('account/login/cancel', {loginId:'late'});
  expect(f.events).toEqual([]);
  f.provider.close();
});
it('ignores completion from a cancelled attempt without clearing the current login', async () => {
  const f = fixture(); let n = 0;
  f.request.mockImplementation(async (method: unknown) => method === 'account/login/start'
    ? {loginId:'login'+(++n),authUrl:'https://auth.openai.com/authorize'} : {});
  await f.provider.login(); await f.provider.cancelLogin(); await f.provider.login();
  f.p.receive({method:'account/login/completed',params:{loginId:'login1',success:false}});
  expect(f.events).toEqual([]);
  await f.provider.cancelLogin();
  expect(f.request).toHaveBeenLastCalledWith('account/login/cancel', {loginId:'login2'});
  f.provider.close();
});
it('preserves matching completion arriving before the login-start response', async () => {
  const f = fixture();
  f.request.mockImplementation(async () => {
    f.p.receive({method:'account/login/completed',params:{loginId:'early',success:true}});
    return {loginId:'early',authUrl:'https://auth.openai.com/authorize'};
  });
  await f.provider.login();
  expect(f.events).toEqual([{kind:'desktop.codex.auth',success:true,message:'Connected to ChatGPT.'}]);
  f.provider.close();
});
