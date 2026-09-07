import { describe, it, expect } from "vitest";
import { connectMcp } from "../core/mcp-stdio";
const fixture = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'echo input',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:m.params.arguments.value}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
describe("desktop MCP process transport", () => {
  it("initializes, discovers and invokes a real stdio subprocess, then cancels it", async () => {
    const abort = new AbortController();
    const connection = await connectMcp(
      {
        name: "fixture",
        command: process.execPath,
        args: ["-e", fixture],
        enabled: true,
      },
      process.cwd(),
      abort.signal,
    );
    try {
      expect(connection.tools[0].name).toBe("mcp_fixture_echo");
      expect(await connection.tools[0].run('{"value":"MCP works"}')).toEqual({
        ok: true,
        output: '[{"type":"text","text":"MCP works"}]',
      });
      abort.abort();
      await expect(
        connection.tools[0].run('{"value":"after close"}'),
      ).rejects.toThrow("closed");
    } finally {
      connection.close();
    }
  });
  it("does not spawn an already-cancelled connection", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      connectMcp(
        { name: "fixture", command: "missing", args: [], enabled: true },
        process.cwd(),
        abort.signal,
      ),
    ).rejects.toThrow("Cancelled");
  });
});
