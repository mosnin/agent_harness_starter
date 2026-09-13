// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { actionSummary } from "../ui/action-summary";

it("shows a readable plan while retaining the complete proposed arguments", () => {
  const input = JSON.stringify({ objective: "Prepare launch", tasks: [{ id: "audit", title: "Audit checkout", prompt: "Inspect" }], maxMinutes: 10 });
  document.body.innerHTML = actionSummary("delegate_work", input);
  expect(document.querySelector("ol")?.textContent).toBe("Audit checkout");
  expect(document.querySelector("details pre")?.textContent).toBe(input);
  expect(document.body.textContent).toContain("progress in this conversation");
});
it("renders supplied instructions as text, including inside technical details", () => {
  document.body.innerHTML = actionSummary("helm_delegate", JSON.stringify({ agent: "opencode", prompt: '<img src=x onerror="evil()">' }));
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("Start coding with Helm");
  expect(document.body.textContent).toContain('<img src=x onerror="evil()">');
});
it("keeps unknown actions and malformed arguments visible without inventing an effect", () => {
  document.body.innerHTML = actionSummary("unknown", "{not json}");
  expect(document.querySelector("pre")?.textContent).toBe("{not json}");
  expect(document.body.textContent).toContain("unknown");
});

it("distinguishes peer observations from parent instructions and explains result review",()=>{
 document.body.innerHTML=actionSummary('delegation_message',JSON.stringify({input:'Observed output'}),{peer:true});
 expect(document.body.textContent).toContain('Send a peer observation');
 document.body.innerHTML=actionSummary('delegation_accept_result',JSON.stringify({summary:'Checked both reports',digest:'abc'}));
 expect(document.querySelector('strong')?.textContent).toBe('Accept reviewed team results');
 expect(document.querySelector('p:nth-child(2)')?.textContent).toBe('Checked both reports');
 expect(document.querySelector('details pre')?.textContent).toContain('abc');
});
