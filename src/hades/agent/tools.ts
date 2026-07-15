/* ------------------------------------------------------------------ *
 * Real, executing, sandboxed tools an agent can call.
 *
 * These are NOT templates. Each tool actually computes its result
 * deterministically with no shell, no network, no fs, no clock, no
 * randomness, and crucially NO `eval` / `new Function` / `with`.
 *
 * The `calc` tool evaluates arithmetic through a hand-written
 * tokenizer + recursive-descent parser so that hostile input such as
 * `"process.exit(1)"` is rejected as a syntax error rather than run.
 * ------------------------------------------------------------------ */

export interface ToolCall {
  tool: string;
  input: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Tool {
  name: string;
  /** One line the model reads to decide when to use it. */
  description: string;
  run: (input: string) => ToolResult | Promise<ToolResult>;
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** All registered tools, sorted by name. */
  list(): Tool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return this.list().map((t) => t.name);
  }

  /**
   * Execute a call. Never throws:
   *  - unknown tool          -> { ok:false, output:"unknown tool: <name>" }
   *  - tool throws / rejects -> { ok:false, output:"error: <msg>" }
   */
  async run(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.tool);
    if (!tool) {
      return { ok: false, output: `unknown tool: ${call.tool}` };
    }
    try {
      return await tool.run(call.input);
    } catch (err) {
      return { ok: false, output: `error: ${messageOf(err)}` };
    }
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Wrap a possibly-throwing body so a tool's own `run` is always total. */
function total(fn: (input: string) => ToolResult): (input: string) => ToolResult {
  return (input: string) => {
    try {
      return fn(input);
    } catch (err) {
      return { ok: false, output: `error: ${messageOf(err)}` };
    }
  };
}

/* ------------------------------------------------------------------ *
 * calc — real arithmetic tokenizer + recursive-descent parser
 *
 * Grammar (standard precedence, left-associative):
 *   expr   := term   (('+' | '-') term)*
 *   term   := factor (('*' | '/' | '%') factor)*
 *   factor := ('+' | '-') factor | primary
 *   primary:= number | '(' expr ')'
 * ------------------------------------------------------------------ */

type Token =
  | { type: "num"; value: number }
  | { type: "op"; value: "+" | "-" | "*" | "/" | "%" }
  | { type: "lparen" }
  | { type: "rparen" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%") {
      tokens.push({ type: "op", value: c });
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i;
      let seenDot = false;
      while (j < src.length) {
        const d = src[j];
        if (d >= "0" && d <= "9") {
          j++;
        } else if (d === ".") {
          if (seenDot) throw new Error("malformed number");
          seenDot = true;
          j++;
        } else {
          break;
        }
      }
      const text = src.slice(i, j);
      if (text === ".") throw new Error("malformed number");
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error("malformed number");
      tokens.push({ type: "num", value });
      i = j;
      continue;
    }
    throw new Error(`unexpected character: ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parse(): number {
    const value = this.expr();
    if (this.pos !== this.tokens.length) {
      throw new Error("unexpected trailing input");
    }
    return value;
  }

  private expr(): number {
    let left = this.term();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "+" || t.value === "-")) {
        this.next();
        const right = this.term();
        left = t.value === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  private term(): number {
    let left = this.factor();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        this.next();
        const right = this.factor();
        if ((t.value === "/" || t.value === "%") && right === 0) {
          throw new Error("division by zero");
        }
        if (t.value === "*") left = left * right;
        else if (t.value === "/") left = left / right;
        else left = left % right;
      } else {
        break;
      }
    }
    return left;
  }

  private factor(): number {
    const t = this.peek();
    if (t && t.type === "op" && (t.value === "+" || t.value === "-")) {
      this.next();
      const operand = this.factor();
      return t.value === "-" ? -operand : operand;
    }
    return this.primary();
  }

  private primary(): number {
    const t = this.next();
    if (!t) throw new Error("unexpected end of input");
    if (t.type === "num") return t.value;
    if (t.type === "lparen") {
      const value = this.expr();
      const close = this.next();
      if (!close || close.type !== "rparen") {
        throw new Error("missing closing parenthesis");
      }
      return value;
    }
    throw new Error("expected number or '('");
  }
}

/** Public helper: evaluate an arithmetic expression via the real parser. */
export function evalArithmetic(expr: string): number {
  const tokens = tokenize(expr);
  if (tokens.length === 0) throw new Error("empty expression");
  return new Parser(tokens).parse();
}

/** Format a number without trailing floating noise but deterministically. */
function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Trim floating-point representation error deterministically.
  const rounded = Number(n.toPrecision(12));
  return String(rounded);
}

/* ------------------------------------------------------------------ *
 * Builtin tools
 * ------------------------------------------------------------------ */

const calcTool: Tool = {
  name: "calc",
  description:
    "Evaluate an arithmetic expression with + - * / %, parentheses, integers and decimals.",
  run: total((input) => {
    const value = evalArithmetic(input);
    if (!Number.isFinite(value)) return { ok: false, output: "non-finite result" };
    return { ok: true, output: formatNumber(value) };
  }),
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const extractEmailsTool: Tool = {
  name: "extract_emails",
  description: "Extract email addresses from text; returns sorted unique comma-separated list.",
  run: total((input) => {
    const found = input.match(EMAIL_RE) ?? [];
    const unique = [...new Set(found)].sort((a, b) => a.localeCompare(b));
    return { ok: true, output: unique.join(",") };
  }),
};

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

const extractNumbersTool: Tool = {
  name: "extract_numbers",
  description: "Extract all numbers from text, comma-separated in order of appearance.",
  run: total((input) => {
    const found = input.match(NUMBER_RE) ?? [];
    return { ok: true, output: found.join(",") };
  }),
};

const jsonGetTool: Tool = {
  name: "json_get",
  description:
    "Input '<json> | <dotpath>': parse the JSON and return the value at the dotted path as a string.",
  run: total((input) => {
    const sep = input.lastIndexOf("|");
    if (sep === -1) return { ok: false, output: "expected '<json> | <dotpath>'" };
    const jsonText = input.slice(0, sep).trim();
    const path = input.slice(sep + 1).trim();
    if (!path) return { ok: false, output: "empty dotpath" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, output: "invalid json" };
    }

    const segments = path.split(".");
    let cur: unknown = parsed;
    for (const seg of segments) {
      if (cur === null || cur === undefined) {
        return { ok: false, output: `path not found: ${path}` };
      }
      if (Array.isArray(cur)) {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
          return { ok: false, output: `path not found: ${path}` };
        }
        cur = cur[idx];
      } else if (typeof cur === "object") {
        const obj = cur as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(obj, seg)) {
          return { ok: false, output: `path not found: ${path}` };
        }
        cur = obj[seg];
      } else {
        return { ok: false, output: `path not found: ${path}` };
      }
    }

    if (cur === null) return { ok: true, output: "null" };
    if (typeof cur === "object") return { ok: true, output: JSON.stringify(cur) };
    return { ok: true, output: String(cur) };
  }),
};

const toJsonTool: Tool = {
  name: "to_json",
  description:
    "Input comma-separated key=value pairs; returns a JSON object (numeric values coerced), key order preserved.",
  run: total((input) => {
    const obj: Record<string, unknown> = {};
    const parts = input.split(",");
    for (const raw of parts) {
      const pair = raw.trim();
      if (pair === "") continue;
      const eq = pair.indexOf("=");
      if (eq === -1) return { ok: false, output: `malformed pair: ${pair}` };
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (key === "") return { ok: false, output: `empty key in: ${pair}` };
      if (value !== "" && !Number.isNaN(Number(value)) && Number.isFinite(Number(value))) {
        obj[key] = Number(value);
      } else {
        obj[key] = value;
      }
    }
    return { ok: true, output: JSON.stringify(obj) };
  }),
};

const wordCountTool: Tool = {
  name: "word_count",
  description: "Return the number of whitespace-separated tokens in the input.",
  run: total((input) => {
    const trimmed = input.trim();
    const count = trimmed === "" ? 0 : trimmed.split(/\s+/).length;
    return { ok: true, output: String(count) };
  }),
};

const uppercaseTool: Tool = {
  name: "uppercase",
  description: "Return the input converted to upper case.",
  run: total((input) => ({ ok: true, output: input.toUpperCase() })),
};

const lowercaseTool: Tool = {
  name: "lowercase",
  description: "Return the input converted to lower case.",
  run: total((input) => ({ ok: true, output: input.toLowerCase() })),
};

/** The safe, real, deterministic builtin toolset. */
export function builtinTools(): Tool[] {
  return [
    calcTool,
    extractEmailsTool,
    extractNumbersTool,
    jsonGetTool,
    toJsonTool,
    wordCountTool,
    uppercaseTool,
    lowercaseTool,
  ];
}

/** A registry pre-loaded with `builtinTools()`. */
export function builtinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);
  return registry;
}
