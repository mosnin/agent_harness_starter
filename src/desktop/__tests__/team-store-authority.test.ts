import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TeamStore,type Member} from '../team/store';
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'hades-team-authority-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const path=join(home,'team.sqlite'),store=new TeamStore(path);cleanups.push(()=>store.close());
 const token=store.create('Team','Owner').token,owner=store.authenticate(token);
 const joined=store.join(store.invite(owner).invite,'Member'),member=store.authenticate(joined.token);
 const channel=(store.snapshot(owner).channels[0] as any).id;
 return {store,path,owner,member,channel};
}
const operations={
 snapshot:(f:ReturnType<typeof fixture>,m:Member)=>f.store.snapshot(m),
 history:(f:ReturnType<typeof fixture>,m:Member)=>f.store.messages(m,f.channel),
 channel:(f:ReturnType<typeof fixture>,m:Member)=>f.store.createChannel(m,'new-channel'),
 send:(f:ReturnType<typeof fixture>,m:Member)=>f.store.send(m,{channel:f.channel,content:'Message',requestId:'new'}),
 read:(f:ReturnType<typeof fixture>,m:Member)=>f.store.markRead(m,f.channel,0),
 invite:(f:ReturnType<typeof fixture>,m:Member)=>f.store.invite(m),
 revoke:(f:ReturnType<typeof fixture>,m:Member)=>f.store.revoke(m,f.owner.id),
};
for(const [name,operation] of Object.entries(operations))it(`rejects stale revoked identity for ${name}`,()=>{
 const f=fixture();const second=new TeamStore(f.path);cleanups.push(()=>second.close());second.revoke(f.owner,f.member.id);
 expect(()=>operation(f,f.member)).toThrow(/revoked|expired/i);
});
it('does not trust a caller-supplied owner role',()=>{
 const f=fixture();expect(()=>f.store.invite({...f.member,role:'owner'})).toThrow(/owner/i);
});
it('rejects cross-team identity even for read-only history',()=>{
 const f=fixture(),other=fixture();expect(()=>f.store.messages(other.owner,f.channel)).toThrow(/revoked|expired/i);
});
it('uses stored member name and role in the snapshot',()=>{
 const f=fixture();expect(f.store.snapshot({...f.member,name:'Forged',role:'owner'}).member).toMatchObject({name:'Member',role:'member'});
});
it('preserves valid message retry and reads',()=>{
 const f=fixture(),data={channel:f.channel,content:'Hello',requestId:'retry'};
 const first=f.store.send(f.member,data);expect(f.store.send(f.member,data)).toEqual({id:first.id,duplicate:true});
 expect(f.store.messages(f.owner,f.channel)).toHaveLength(1);
});
it('rolls back a rejected operation and leaves subsequent authorized work usable',()=>{
 const f=fixture();expect(()=>f.store.createChannel(f.member,'general')).toThrow(/already exists/);
 const channel=f.store.createChannel(f.member,'allowed');expect(channel.name).toBe('allowed');
 expect(()=>f.store.invite(f.member)).toThrow(/owner/i);
 const invitation=f.store.invite(f.owner);expect(f.store.join(invitation.invite,'New member').member.name).toBe('New member');
});
it('preserves authorization after opening the durable store again',()=>{
 const f=fixture();const reopened=new TeamStore(f.path);cleanups.push(()=>reopened.close());
 expect(reopened.snapshot(f.member).member.id).toBe(f.member.id);
 reopened.revoke(f.owner,f.member.id);expect(()=>f.store.send(f.member,{channel:f.channel,content:'Late',requestId:'late'})).toThrow(/revoked/);
 expect(f.store.messages(f.owner,f.channel)).toEqual([]);
});
it('does not permit a retry to disclose a previous message after revocation',()=>{
 const f=fixture(),data={channel:f.channel,content:'Original',requestId:'same'};
 f.store.send(f.member,data);f.store.revoke(f.owner,f.member.id);
 expect(()=>f.store.send(f.member,data)).toThrow(/revoked/);expect(f.store.messages(f.owner,f.channel)).toHaveLength(1);
});
