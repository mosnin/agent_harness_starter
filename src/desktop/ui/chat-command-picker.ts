import { CHAT_COMMANDS } from "../core/chat-commands";
/** A composer-owned picker. It never replaces the textarea or submits a turn. */
export function bindChatCommands(
  input: HTMLTextAreaElement,
  host: HTMLElement,
  choose: (value: string) => void,
  loadSkills: () => Promise<Array<{ name: string }>>,
) {
  let selected = 0,
    dismissed = "",
    version = 0,
    skills: Array<{ name: string }> = [],
    loaded = false;
  let options: Array<{ label: string; description: string; value: string }> =
    [];
  const render = () => {
    host.replaceChildren();
    const value = input.value;
    options = [];
    if (value === dismissed || !/^\/(?:[\w-]*|skill [\w:.-]*)$/.test(value)) {
      host.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const skillMode = value.startsWith("/skill "),
      query = skillMode ? value.slice(7) : value.slice(1);
    options = skillMode
      ? skills
          .filter((s) => s.name.startsWith(query))
          .map((s) => ({
            label: s.name,
            description: "Apply this installed skill",
            value: "/skill " + s.name + " ",
          }))
      : CHAT_COMMANDS.filter((c) => c.name.startsWith(query)).map((c) => ({
          label: "/" + c.name,
          description: c.description,
          value: "/" + c.name + " ",
        }));
    selected = Math.min(selected, Math.max(0, options.length - 1));
    host.hidden = !options.length;
    input.setAttribute("aria-expanded", String(!!options.length));
    if (!options.length) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    input.setAttribute("aria-activedescendant", `chat-command-${selected}`);
    options.forEach((option, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.id = `chat-command-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === selected));
      row.tabIndex = -1;
      const label = document.createElement("strong"),
        description = document.createElement("span");
      label.textContent = option.label;
      description.textContent = option.description;
      row.append(label, description);
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = () => select(index);
      host.append(row);
    });
  };
  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    input.value = option.value;
    choose(option.value);
    selected = 0;
    dismissed = "";
    render();
    input.focus();
    if (option.value === "/skill ") void fetchSkills();
  };
  const fetchSkills = async () => {
    if (loaded) return;
    const ticket = ++version;
    try {
      const result = await loadSkills();
      if (ticket !== version || !input.isConnected) return;
      skills = result;
      loaded = true;
      render();
    } catch {
      if (ticket !== version || !input.isConnected) return;
      options = [];
      host.hidden = false;
      host.textContent = "Could not load skills. Type again to retry.";
    }
  };
  input.setAttribute("aria-controls", host.id);
  input.setAttribute("aria-autocomplete", "list");
  host.setAttribute("role", "listbox");
  host.setAttribute("aria-label", "Chat commands");
  input.addEventListener("input", () => {
    selected = 0;
    dismissed = "";
    render();
    if (input.value.startsWith("/skill ")) void fetchSkills();
  });
  input.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing || !options.length) return;
      if (
        ["ArrowDown", "ArrowUp", "Escape", "Tab", "Enter"].includes(e.key) &&
        !e.shiftKey
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "Escape") {
          dismissed = input.value;
          render();
        } else if (e.key === "Tab" || e.key === "Enter") select(selected);
        else {
          selected =
            (selected + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
          render();
          host
            .querySelector<HTMLElement>('[aria-selected="true"]')
            ?.scrollIntoView?.({ block: "nearest" });
        }
      }
    },
    true,
  );
  render();
  if (input.value.startsWith("/skill ")) void fetchSkills();
}
