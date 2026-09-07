// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ManagementView } from "../ui/management";
const hosts:HTMLElement[] = [];
afterEach(() => { hosts.forEach(h => h.remove()); hosts.length = 0; });
async function settle() { for(let i=0;i<10;i++) await Promise.resolve(); }
function input(host:HTMLElement,id:string,value:string) { const el=host.querySelector<HTMLInputElement>(`#${id}`)!; el.value=value; el.dispatchEvent(new Event("input")); }
function click(host:HTMLElement,action:string) { host.querySelector<HTMLButtonElement>(`[data-manage="${action}"]`)!.click(); }
function setup(rpc:any) {const host=document.createElement("div");document.body.append(host);hosts.push(host);const open=vi.fn(),nav=vi.fn(),download=vi.fn();const view=new ManagementView(rpc,open,nav,download);view.bind(host);return {host,view,open,nav,download};}
it("submits full-content filters, resumes exact sessions, and exports server data",async () => {
  const rpc=vi.fn(async (method:string) => method === "session.export" ? {title:"Actual saved title",messages:[]} : {rows:[{id:"s",title:"<unsafe>",source:"desktop",count:2,updatedAt:1,snippet:"old match"}],total:1,offset:0,stats:{total:1,running:0,archived:0,messages:2}});
  const {host,view,open,download}=setup(rpc);await view.open("sessions","p","Agent","/project");
  expect(host.querySelector("unsafe")).toBeNull();input(host,"history-query","old words");host.querySelector("form")!.dispatchEvent(new Event("submit",{cancelable:true}));await settle();
  expect(rpc).toHaveBeenLastCalledWith("sessions.list",expect.objectContaining({profile:"p",query:"old words"}));
  click(host,"open");expect(open).toHaveBeenCalledWith("s");click(host,"export");await settle();expect(download).toHaveBeenCalledWith("conversation-s.json",{title:"Actual saved title",messages:[]});
});
it("keeps unsaved MCP fields across refresh and preserves one argument per line",async () => {
  const rpc=vi.fn(async () => []);const {host,view}=setup(rpc);await view.open("mcp","p","Agent","/project");click(host,"add");
  input(host,"mcp-name","my-server");input(host,"mcp-command","/my server/bin");input(host,"mcp-args","--label\na value with spaces");
  await view.open("mcp","p","Agent","/project");expect(host.querySelector<HTMLInputElement>("#mcp-name")!.value).toBe("my-server");
  click(host,"save-mcp");await settle();expect(rpc).toHaveBeenCalledWith("mcp.save",expect.objectContaining({profile:"p",name:"my-server",command:"/my server/bin",args:["--label","a value with spaces"],enabled:false}));
});
it("does not render a stale response from another profile",async () => {
  let first!:(value:unknown)=>void;const rpc=vi.fn((_method:string,a:any) => a.profile === "one" ? new Promise(resolve => {first=resolve;}) : Promise.resolve([]));
  const {host,view}=setup(rpc);const pending=view.open("mcp","one","One","/one");await view.open("mcp","two","Two","/two");first([{name:"private one",command:"secret"}]);await pending;
  expect(host.textContent).toContain("Two");expect(host.textContent).not.toContain("private one");
});
it("offers Work and Webhook filters and submits their exact source values", async () => {
  const rpc = vi.fn(async () => ({ rows: [], total: 0, offset: 0 }));
  const { host, view } = setup(rpc); await view.open("sessions", "p", "Agent", "/project");
  const values = [...host.querySelectorAll<HTMLOptionElement>("#history-source option")].map(option => option.value);
  expect(values).toContain("work"); expect(values).toContain("webhook");
  for (const source of ["work", "webhook"]) {
    input(host, "history-source", source);
    host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(rpc).toHaveBeenLastCalledWith("sessions.list", expect.objectContaining({ profile: "p", source }));
  }
});
