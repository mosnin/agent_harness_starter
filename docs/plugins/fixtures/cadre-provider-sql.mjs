// Explicit local dependency and migration path required; no network/server setup.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.HADES_PGLITE_MODULE;
const migrationPath = process.env.HADES_CADRE_MIGRATION;
if (!modulePath || !migrationPath) throw new Error('Provide explicit local fixture dependency and migration paths.');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const open = [];
afterEach(async () => { for (const db of open.splice(0)) await db.close(); });
async function database() {
 const db = new PGlite(); open.push(db);
 await db.exec(`create role fixture_business;
 create table spaces(id text primary key,"organizationId" text,name text,"createdAt" timestamptz default now());
 create table "user"(id text primary key,"suspendedAt" timestamptz);
 create table member("organizationId" text,"userId" text);
 create table space_members("spaceId" text,"organizationId" text,"userId" text,role text);
 create table bots(id text primary key,"spaceId" text,"userId" text,name text,"updatedAt" timestamptz default now(),instructions text,"webhookSecretId" text);
 create table tasks(id text primary key,"spaceId" text,"userId" text,prompt text,status text,"updatedAt" timestamptz default now());
 insert into spaces(id,"organizationId",name) values('space','org','Fixture');insert into "user"(id) values('actor'),('other');
 insert into member values('org','actor'),('org','other');insert into space_members values('space','org','actor','member'),('space','org','other','member');
 insert into bots(id,"spaceId","userId",name,instructions,"webhookSecretId") values('owned','space','actor','Original','PRIVATE-INSTRUCTIONS','CREDENTIAL'),('other-owned','space','other','Other','PRIVATE','SECRET');
 insert into tasks(id,"spaceId","userId",prompt,status) values('task','space','actor','Bounded task','completed');`);
 await db.exec(readFileSync(migrationPath, 'utf8'));
 await db.exec(`insert into hades_oauth_grants(actor_id,tenant_id,client_id,redirect_uri,scopes,state,challenge,consent_hash,consent_expires,consent_used,code_hash,code_expires)
 values('actor','space','hades-desktop-cadre','ai.hades.desktop:/oauth/cadre',array['bots:read','tasks:read','spaces:read','bots:write'],'state','pkce','consent',now()+interval '1 minute',true,'code',now()+interval '1 minute');`);
 return db;
}
async function exchange(db, options = {}) {
 const {kind='authorization_code',token='code',client='hades-desktop-cadre',redirect='ai.hades.desktop:/oauth/cadre',pkce='pkce',access='access',refresh='refresh'}=options;
 return (await db.query('select hades_exchange($1,$2,$3,$4,$5,$6,$7) as result',[kind,token,client,redirect,pkce,access,refresh])).rows[0].result;
}
test('code replay requires exact client/redirect/PKCE before committed family revocation', async()=>{
 const db=await database();assert.ok((await exchange(db)).scope);
 for(const options of [{pkce:'wrong'},{client:'other'},{redirect:'https://evil.example'}]) {assert.equal((await exchange(db,options)).error,'invalid_grant');assert.equal((await db.query('select revoked from hades_oauth_grants')).rows[0].revoked,false);}
 assert.equal((await exchange(db)).error,'invalid_grant');await assert.rejects(db.query("select hades_access('access',false)"),/invalid_token/);
});
test('current owner-scoped bot CAS and durable receipt allow one edit and reject another actor',async()=>{
 const db=await database();await exchange(db);const revision=(await db.query("select revision::text from hades_records where id='owned' and collection='bots'")).rows[0].revision;
 const args=['access','request-one','owned',revision,'Renamed'];const first=(await db.query('select hades_rename($1,$2,$3,$4,$5) as result',args)).rows[0].result;
 assert.equal(first.record.title,'Renamed');assert.deepEqual((await db.query('select hades_rename($1,$2,$3,$4,$5) as result',args)).rows[0].result,first);
 await assert.rejects(db.query('select hades_rename($1,$2,$3,$4,$5)',['access','request-two','owned',revision,'Other']),/revision_conflict/);
 await assert.rejects(db.query('select hades_rename($1,$2,$3,$4,$5)',['access','request-one','owned',revision,'Other']),/idempotency_conflict/);
 await assert.rejects(db.query("select hades_rename('access','foreign-request','other-owned','1','No')"),/not_found/);
 assert.equal((await db.query('select count(*)::int as count from hades_write_receipts')).rows[0].count,1);
});
test('existing business-role bot writes still capture private projections without direct grants',async()=>{
 const db=await database();await db.exec('grant select,update on bots to fixture_business; set role fixture_business;');
 await db.exec("update bots set name='Existing path' where id='owned'");
 await assert.rejects(db.query('select * from hades_oauth_grants'),/permission denied/);
 await assert.rejects(db.query("select hades_project('{}'::jsonb,'bots',false)"),/permission denied/);
 await db.exec('reset role');assert.equal((await db.query("select record->>'title' as title from hades_records where id='owned'")).rows[0].title,'Existing path');
});
test('reassigned records publish old actor tombstone then new actor revision and deletion',async()=>{
 const db=await database();const cursor=(await db.query("select seq from hades_clocks where tenant_id='space'")).rows[0].seq;
 await db.exec("update bots set \"userId\"='other' where id='owned'");
 const changes=(await db.query('select actor_id,change from hades_changes where seq>$1 order by seq',[cursor])).rows;
 assert.equal(changes[0].actor_id,'actor');assert.equal(changes[0].change.deleted.id,'owned');assert.equal(changes[1].actor_id,'other');
 await db.exec("delete from bots where id='owned'");assert.equal((await db.query("select count(*)::int as count from hades_records where id='owned'")).rows[0].count,0);
 const all=JSON.stringify((await db.query('select record from hades_records')).rows);assert.ok(!all.includes('PRIVATE-INSTRUCTIONS'));assert.ok(!all.includes('CREDENTIAL'));
});
test('refresh replay and suspension invalidate current authority',async()=>{
 const db=await database();await exchange(db);
 assert.ok((await exchange(db,{kind:'refresh_token',token:'refresh',access:'access-two',refresh:'refresh-two'})).scope);
 assert.equal((await exchange(db,{kind:'refresh_token',token:'refresh',client:'other'})).error,'invalid_grant');assert.equal((await db.query('select revoked from hades_oauth_grants')).rows[0].revoked,false);
 assert.equal((await exchange(db,{kind:'refresh_token',token:'refresh'})).error,'invalid_grant');await assert.rejects(db.query("select hades_access('access-two',false)"),/invalid_token/);
 await db.exec("update hades_oauth_grants set revoked=false; update \"user\" set \"suspendedAt\"=now() where id='actor'");await assert.rejects(db.query("select hades_access('access-two',false)"),/invalid_token/);
});
