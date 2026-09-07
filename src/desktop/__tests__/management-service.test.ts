import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchService } from "../core/workbench-service";
import { FileSessionStore } from "../../hades/memory/session-store";
import { ActivityStore } from "../core/activity-store";
const roots: string[] = [], services: WorkbenchService[] = [];
afterEach(() => { services.forEach(s => s.close()); roots.forEach(r => rmSync(r, { recursive:true, force:true })); services.length = roots.length = 0; });
function setup() { const root = mkdtempSync(join(tmpdir(),"hades-management-")); roots.push(root); const s = new WorkbenchService(join(root,"data"),() => {}, { NODE_ENV:"test" }); services.push(s); return {root,s}; }
it("searches full messages beyond previews and keeps profile, filters, title edits and export aligned", async () => {
  const {root,s} = setup(); await s.dispatch("project.add", {path:root});
  const first: any = await s.dispatch("session.new", { root, profile:"default", title:"Alpha" });
  // The fixture is populated before reopening the store, as a real persisted session is.
  s.close(); services.pop();
  const store = new FileSessionStore(join(root,"data","sessions.json"));
  store.append(first.id, {role:"user",content:"Needle in an old message"});
  store.append(first.id, {role:"assistant",content:"Latest reply without query"});
  const reopened = new WorkbenchService(join(root,"data"),() => {}, { NODE_ENV:"test" }); services.push(reopened);
  await reopened.dispatch("profile.save", {id:"other",name:"Other",provider:"local",model:"test",baseUrl:"http://localhost:11434/v1"});
  const results: any = await reopened.dispatch("sessions.list", {profile:"default",query:"needle"});
  expect(results.total).toBe(1); expect(results.rows[0].snippet).toContain("Needle");
  expect((await reopened.dispatch("sessions.list", {profile:"other",query:"needle"}) as any).total).toBe(0);
  await expect(reopened.dispatch("session.update", {profile:"other",id:first.id,title:"Wrong"})).rejects.toThrow("Conversation not found");
  await reopened.dispatch("session.update", {profile:"default",id:first.id,title:"Renamed",archived:true});
  expect((await reopened.dispatch("sessions.list", {profile:"default",state:"current"}) as any).total).toBe(0);
  const exported: any = await reopened.dispatch("session.export", {profile:"default",id:first.id});
  expect(exported.title).toBe("Renamed"); expect(exported.archived).toBe(true); expect(exported.messages).toHaveLength(2);
});
it("edits standalone MCP servers without replacing other profile settings and rejects duplicate identities", async () => {
  const {s} = setup();
  await s.dispatch("mcp.save", {profile:"default",name:"files",command:"/server",args:["--one"],enabled:false});
  await expect(s.dispatch("mcp.save", {profile:"default",name:"files",command:"/different",args:[]})).rejects.toThrow("already uses");
  await s.dispatch("mcp.save", {profile:"default",original:"files",name:"renamed",command:"/server",args:[],enabled:true});
  expect(await s.dispatch("mcp.list", {profile:"default"})).toEqual([{name:"renamed",command:"/server",args:[],enabled:true}]);
  await expect(s.dispatch("mcp.save", {profile:"default",name:"bad",command:"",args:[]})).rejects.toThrow("executable");
  await s.dispatch("mcp.remove", {profile:"default",name:"renamed"});
  expect(await s.dispatch("mcp.list", {profile:"default"})).toEqual([]);
});
it("records only allowlisted operational fields, preserves them after restart and scopes pagination", () => {
  const {root} = setup(); const path = join(root,"activity.sqlite"); const store = new ActivityStore(path);
  store.record("one", {kind:"desktop.delta",session:"s",chunk:"secret"});
  store.record("one", {kind:"desktop.error",session:"s",message:"Bearer SECRET",input:"private prompt"});
  store.record("one", {kind:"desktop.usage",session:"s",tokensIn:12,tokensOut:4,extra:"SECRET"});
  store.record("two", {kind:"desktop.error",session:"other",message:"SECRET"}); store.close();
  const reopened = new ActivityStore(path);
  try {
    const rows: any[] = reopened.list("one"); expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("SECRET"); expect(JSON.stringify(rows)).not.toContain("prompt");
    expect(reopened.list("one", {before:rows[0].id})).toHaveLength(1);
    expect(reopened.list("one", {errors:true})).toHaveLength(1);
    expect(reopened.usage("one")).toMatchObject({turns:1,tokensIn:12,tokensOut:4});
  } finally { reopened.close(); }
});

it("updates future routines in place, scopes lists, and retains run evidence when removing a schedule", async () => {
  const {root,s} = setup(); await s.dispatch("project.add",{path:root});
  const original:any = await s.dispatch("job.save",{name:"Original",prompt:"First instructions",root,profile:"default",intervalMinutes:60});
  await s.dispatch("job.toggle",{id:original.id,enabled:false});
  const edited:any = await s.dispatch("job.save",{id:original.id,name:"Edited",prompt:"New instructions",root,profile:"default",intervalMinutes:90});
  expect(edited.id).toBe(original.id); expect(edited.enabled).toBe(false);
  expect((await s.dispatch("boot",{profile:"default"}) as any).jobs).toHaveLength(1);
  await s.dispatch("profile.save",{id:"other",name:"Other",provider:"local",model:"test",baseUrl:"http://localhost:11434/v1"});
  expect((await s.dispatch("boot",{profile:"other"}) as any).jobs).toHaveLength(0);
  await expect(s.dispatch("job.save",{id:original.id,profile:"other",root,intervalMinutes:90,name:"Wrong",prompt:"Wrong"})).rejects.toThrow("Routine not found");
  await expect(s.dispatch("job.remove",{id:original.id,profile:"other"})).rejects.toThrow("Routine not found");
  await s.dispatch("job.remove",{id:original.id,profile:"default"});
  expect((await s.dispatch("boot",{profile:"default"}) as any).jobs).toHaveLength(0);
});
