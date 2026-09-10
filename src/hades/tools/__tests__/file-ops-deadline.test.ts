import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { prepareFileOperation, __internal } from "../file-ops";
vi.mock("node:fs/promises", () => ({ realpath: vi.fn(), lstat: vi.fn(), open: vi.fn(), readdir: vi.fn() }));
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes,no) => { resolve=yes;reject=no; }); return {promise,resolve,reject}; };
const info = { size: 0, isDirectory:()=>false, isSymbolicLink:()=>false, isFile:()=>true, mtimeMs:1 };
const handle = () => ({stat:vi.fn().mockResolvedValue(info),read:vi.fn().mockResolvedValue({bytesRead:0}),close:vi.fn().mockResolvedValue(undefined)});
let serial=0, root:string;
beforeEach(()=>{vi.useFakeTimers();vi.resetAllMocks();root='/synthetic-file-deadline-'+(++serial);vi.mocked(fs.realpath).mockImplementation(async path=>String(path));vi.mocked(fs.lstat).mockResolvedValue(info as any);vi.mocked(fs.readdir).mockResolvedValue([]);});
afterEach(()=>{vi.useRealTimers();});
const start = (root:string,op='read',options={}) => prepareFileOperation(root,JSON.stringify({op,path:'index.html'}),options).run();

it('bounds blocked open, refuses new reads across prepared objects and roots, and tracks late close before recovery',async()=>{
 const open=deferred<any>(),close=deferred<void>(),late=handle();late.close.mockImplementation(()=>close.promise);vi.mocked(fs.open).mockReturnValue(open.promise);
 const pending=start(root);await vi.advanceTimersByTimeAsync(10000);expect(await pending).toMatchObject({ok:false,output:expect.stringContaining('filesystem permissions')});
 const calls=vi.mocked(fs.realpath).mock.calls.length;
 expect(await start(root)).toMatchObject({ok:false,output:expect.stringContaining('previous file read')});
 expect(await start('/another-root')).toMatchObject({ok:false,output:expect.stringContaining('previous file read')});
 expect(fs.realpath).toHaveBeenCalledTimes(calls);expect(fs.open).toHaveBeenCalledTimes(1);
 open.resolve(late);await vi.advanceTimersByTimeAsync(0);expect(late.close).toHaveBeenCalledTimes(1);expect(late.stat).not.toHaveBeenCalled();expect(late.read).not.toHaveBeenCalled();
 expect(await start(root)).toMatchObject({ok:false,output:expect.stringContaining('previous file read')});
 close.reject(new Error('close failed'));await vi.advanceTimersByTimeAsync(0);
 const next=handle();vi.mocked(fs.open).mockResolvedValue(next as any);expect((await start(root)).ok).toBe(true);expect(next.close).toHaveBeenCalledTimes(1);
});

it('cancels a pending stat, closes the handle without waiting, and never starts a late read',async()=>{
 const stat=deferred<any>(),close=deferred<void>(),file=handle();file.stat.mockReturnValue(stat.promise);file.close.mockReturnValue(close.promise);vi.mocked(fs.open).mockResolvedValue(file as any);
 const controller=new AbortController(),pending=start(root,'read',{signal:controller.signal});await vi.advanceTimersByTimeAsync(0);expect(file.stat).toHaveBeenCalledTimes(1);
 controller.abort();expect(await pending).toMatchObject({ok:false,output:expect.stringContaining('cancelled')});expect(file.close).toHaveBeenCalledTimes(1);
 expect(await start(root)).toMatchObject({ok:false,output:expect.stringContaining('previous file read')});
 stat.resolve(info);await vi.advanceTimersByTimeAsync(0);expect(file.read).not.toHaveBeenCalled();
 expect(await start(root)).toMatchObject({ok:false,output:expect.stringContaining('previous file read')});
 close.resolve();await vi.advanceTimersByTimeAsync(0);
});

it('bounds jail realpath and suppresses later traversal or open',async()=>{
 const path=deferred<string>();vi.mocked(fs.realpath).mockReturnValueOnce(path.promise);
 const pending=start(root);await vi.advanceTimersByTimeAsync(10000);expect((await pending).ok).toBe(false);
 path.resolve(root);await vi.advanceTimersByTimeAsync(0);expect(fs.realpath).toHaveBeenCalledTimes(1);expect(fs.open).not.toHaveBeenCalled();
});

it('bounds fallback lstat in jail resolution without walking to another ancestor',async()=>{
 const stat=deferred<any>();vi.mocked(fs.realpath).mockRejectedValueOnce(Object.assign(new Error('missing'),{code:'ENOENT'}));vi.mocked(fs.lstat).mockReturnValueOnce(stat.promise);
 const pending=start(root);await vi.advanceTimersByTimeAsync(10000);expect((await pending).ok).toBe(false);
 stat.reject(Object.assign(new Error('missing'),{code:'ENOENT'}));await vi.advanceTimersByTimeAsync(0);expect(fs.realpath).toHaveBeenCalledTimes(1);expect(fs.open).not.toHaveBeenCalled();
});

it.each(['stat','list'])('bounds a blocked %s operation',async op=>{
 const blocked=deferred<any>();if(op==='stat')vi.mocked(fs.lstat).mockReturnValue(blocked.promise);else vi.mocked(fs.readdir).mockReturnValue(blocked.promise);
 const pending=start(root,op);await vi.advanceTimersByTimeAsync(10000);expect(await pending).toMatchObject({ok:false,output:expect.stringContaining('timed out')});
 blocked.resolve(op==='stat'?info:[]);await vi.advanceTimersByTimeAsync(0);
});

it('bounds read and normal close and handles late rejection without replay',async()=>{
 const read=deferred<any>(),file=handle();file.stat.mockResolvedValue({...info,size:1});file.read.mockReturnValue(read.promise);vi.mocked(fs.open).mockResolvedValue(file as any);
 const pending=start(root);await vi.advanceTimersByTimeAsync(10000);expect((await pending).ok).toBe(false);expect(file.close).toHaveBeenCalledTimes(1);
 read.reject(new Error('late read failure'));await vi.advanceTimersByTimeAsync(0);expect(file.read).toHaveBeenCalledTimes(1);
 const close=deferred<void>(),second=handle();second.close.mockReturnValue(close.promise);vi.mocked(fs.open).mockResolvedValue(second as any);
 const next=start(root);await vi.advanceTimersByTimeAsync(10000);expect((await next).ok).toBe(false);expect(second.close).toHaveBeenCalledTimes(1);
 close.resolve();await vi.advanceTimersByTimeAsync(0);
});

it('uses one whole-operation deadline and refuses already-cancelled reads before filesystem access',async()=>{
 const file=handle();vi.mocked(fs.open).mockResolvedValue(file as any);
 vi.mocked(fs.realpath).mockImplementation(path=>new Promise(resolve=>setTimeout(()=>resolve(String(path)),40)));
 file.stat.mockImplementation(()=>new Promise(resolve=>setTimeout(()=>resolve(info),40)));
 const pending=start(root,'read',{readTimeoutMs:100});await vi.advanceTimersByTimeAsync(100);expect((await pending).ok).toBe(false);expect(file.read).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(20);expect(file.read).not.toHaveBeenCalled();
 vi.mocked(fs.realpath).mockClear();const controller=new AbortController();controller.abort();expect((await start(root,'stat',{signal:controller.signal})).ok).toBe(false);expect(fs.realpath).not.toHaveBeenCalled();
});

it('retains every concurrently abandoned read until all underlying operations settle',async()=>{
 const first=deferred<any>(),second=deferred<any>();vi.mocked(fs.open).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
 const a=start(root),b=start(root);await vi.advanceTimersByTimeAsync(10000);expect((await a).ok).toBe(false);expect((await b).ok).toBe(false);
 second.resolve(handle());await vi.advanceTimersByTimeAsync(0);expect(await start('/third-root')).toMatchObject({ok:false,output:expect.stringContaining('previous file read')});expect(fs.open).toHaveBeenCalledTimes(2);
 first.resolve(handle());await vi.advanceTimersByTimeAsync(0);
});

it('still closes an already-open handle when another root becomes blocked',async()=>{
 const blocked=deferred<any>(),stat=deferred<any>(),file=handle();file.stat.mockReturnValue(stat.promise);
 vi.mocked(fs.open).mockReturnValueOnce(blocked.promise).mockResolvedValueOnce(file as any);
 const abandoned=start(root,'read',{readTimeoutMs:100}),other=start('/active-other-root','read',{readTimeoutMs:1000});
 await vi.advanceTimersByTimeAsync(100);expect((await abandoned).ok).toBe(false);
 stat.resolve(info);await vi.advanceTimersByTimeAsync(0);expect((await other).ok).toBe(false);expect(file.read).not.toHaveBeenCalled();expect(file.close).toHaveBeenCalledTimes(1);
 blocked.resolve(handle());await vi.advanceTimersByTimeAsync(0);
});

it('runs queued close despite cancellation before its microtask and holds the guard until cleanup settles',async()=>{
 const controller=new AbortController(),deadline=new __internal.ReadDeadline(root,{signal:controller.signal}),close=deferred<void>(),closeCall=vi.fn(()=>close.promise);
 const pending=deadline.wait(closeCall,undefined,true);const rejected=expect(pending).rejects.toThrow('cancelled');controller.abort();await rejected;
 expect(closeCall).toHaveBeenCalledTimes(1);
 expect(await start('/another-root')).toMatchObject({ok:false,output:expect.stringContaining('previous file read')});
 close.reject(new Error('late close rejection'));await vi.advanceTimersByTimeAsync(0);deadline.dispose();
});
