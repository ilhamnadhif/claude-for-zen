// Keyboard helpers: translate human key names ("cmd+a", "Return", "Page_Down")
// into WebDriver key values and BiDi input action sequences.

export const KEY = {
  Cancel: "",
  Help: "",
  Backspace: "",
  Tab: "",
  Clear: "",
  Enter: "",
  Shift: "",
  Control: "",
  Alt: "",
  Pause: "",
  Escape: "",
  Space: "",
  PageUp: "",
  PageDown: "",
  End: "",
  Home: "",
  ArrowLeft: "",
  ArrowUp: "",
  ArrowRight: "",
  ArrowDown: "",
  Insert: "",
  Delete: "",
  Meta: "",
};

const NAMED = new Map(
  Object.entries({
    enter: KEY.Enter,
    return: KEY.Enter,
    kpenter: KEY.Enter,
    tab: KEY.Tab,
    escape: KEY.Escape,
    esc: KEY.Escape,
    backspace: KEY.Backspace,
    delete: KEY.Delete,
    del: KEY.Delete,
    space: " ",
    spacebar: " ",
    up: KEY.ArrowUp,
    arrowup: KEY.ArrowUp,
    down: KEY.ArrowDown,
    arrowdown: KEY.ArrowDown,
    left: KEY.ArrowLeft,
    arrowleft: KEY.ArrowLeft,
    right: KEY.ArrowRight,
    arrowright: KEY.ArrowRight,
    home: KEY.Home,
    end: KEY.End,
    pageup: KEY.PageUp,
    prior: KEY.PageUp,
    pagedown: KEY.PageDown,
    next: KEY.PageDown,
    insert: KEY.Insert,
    ins: KEY.Insert,
    pause: KEY.Pause,
    clear: KEY.Clear,
    help: KEY.Help,
    shift: KEY.Shift,
    ctrl: KEY.Control,
    control: KEY.Control,
    alt: KEY.Alt,
    option: KEY.Alt,
    opt: KEY.Alt,
    meta: KEY.Meta,
    cmd: KEY.Meta,
    command: KEY.Meta,
    super: KEY.Meta,
    win: KEY.Meta,
    windows: KEY.Meta,
    os: KEY.Meta,
    plus: "+",
    minus: "-",
    comma: ",",
    period: ".",
    slash: "/",
    backslash: "\\",
    semicolon: ";",
    apostrophe: "'",
    quote: "'",
    grave: "`",
    backtick: "`",
    bracketleft: "[",
    bracketright: "]",
    equal: "=",
    equals: "=",
  }),
);
for (let i = 1; i <= 12; i++) NAMED.set(`f${i}`, String.fromCharCode(0xe031 + i - 1));

/** Errors from parsing user-supplied key names are shown to the model verbatim. */
export class KeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "KeyError";
    this.userFacing = true;
  }
}

export const MODIFIER_VALUES = new Set([KEY.Shift, KEY.Control, KEY.Alt, KEY.Meta]);

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[\s_-]/g, "")
    .replace(/(l|r)$/, (m, side, offset, str) => {
      // shift_l / control_r / super_l → shift / control / super
      const base = str.slice(0, -1);
      return ["shift", "control", "ctrl", "alt", "super", "meta", "cmd", "command", "option"].includes(base) ? "" : m;
    });
}

/** Resolve a single key token (named key or one character) to a WebDriver key value. */
export function keyValue(token) {
  if (token == null || token === "") throw new KeyError("Empty key name");
  const chars = Array.from(token);
  if (chars.length === 1) return token;
  const v = NAMED.get(normalizeName(token));
  if (v !== undefined) return v;
  throw new KeyError(`Unknown key "${token}". Use names like Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, or combos like "ctrl+a" / "cmd+shift+t".`);
}

/** Split "ctrl+shift+a" into tokens, allowing "+" itself as a key ("ctrl++"). */
function splitCombo(combo) {
  if (combo === "+") return ["+"];
  const parts = combo.split("+");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "" && i === parts.length - 1 && out.length) {
      // trailing "+" → the plus key
      out.push("+");
      break;
    }
    if (parts[i] === "") continue;
    out.push(parts[i]);
  }
  return out;
}

/**
 * Parse a key sequence: space separated combos, e.g. "ctrl+a Backspace Enter".
 * @returns {{modifiers: string[], key: string|null}[]}
 */
export function parseKeySequence(text) {
  const combos = String(text).trim().split(/\s+/).filter(Boolean);
  if (!combos.length) throw new KeyError("No keys given");
  return combos.map((combo) => {
    const values = splitCombo(combo).map(keyValue);
    if (!values.length) throw new KeyError(`Could not parse key combo "${combo}"`);
    const key = values[values.length - 1];
    const modifiers = values.slice(0, -1);
    for (const m of modifiers) {
      if (!MODIFIER_VALUES.has(m)) throw new KeyError(`"${combo}": only shift/ctrl/alt/cmd can be combined with "+"`);
    }
    return { modifiers, key };
  });
}

/** Parse click modifiers like "ctrl+shift" or "cmd". */
export function parseModifiers(text) {
  if (!text) return [];
  return splitCombo(String(text).trim()).map((t) => {
    const v = keyValue(t);
    if (!MODIFIER_VALUES.has(v)) throw new KeyError(`"${t}" is not a modifier key (use ctrl, shift, alt, cmd/meta)`);
    return v;
  });
}

/** BiDi key actions for a parsed sequence. */
export function keyActionsForSequence(seq, repeat = 1) {
  const actions = [];
  for (let r = 0; r < repeat; r++) {
    for (const { modifiers, key } of seq) {
      for (const m of modifiers) actions.push({ type: "keyDown", value: m });
      actions.push({ type: "keyDown", value: key });
      actions.push({ type: "keyUp", value: key });
      for (const m of [...modifiers].reverse()) actions.push({ type: "keyUp", value: m });
    }
  }
  return actions;
}

/** BiDi key actions that type `text` character by character. */
export function keyActionsForText(text) {
  const actions = [];
  for (const ch of Array.from(String(text).replace(/\r\n?/g, "\n"))) {
    const value = ch === "\n" ? KEY.Enter : ch === "\t" ? KEY.Tab : ch;
    actions.push({ type: "keyDown", value });
    actions.push({ type: "keyUp", value });
  }
  return actions;
}
