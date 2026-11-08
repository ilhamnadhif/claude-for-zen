// Turn WebDriver BiDi RemoteValues into readable text.

function nodeSummary(v) {
  const val = v.value || {};
  switch (val.nodeType) {
    case 1: {
      const attrs = val.attributes || {};
      let s = `<${val.localName || "element"}`;
      if (attrs.id) s += ` id="${attrs.id}"`;
      if (attrs.class) s += ` class="${String(attrs.class).slice(0, 80)}"`;
      for (const k of ["name", "type", "href", "src", "role", "aria-label"]) {
        if (attrs[k]) s += ` ${k}="${String(attrs[k]).slice(0, 80)}"`;
      }
      return `${s}>`;
    }
    case 3:
      return `#text ${JSON.stringify(String(val.nodeValue ?? "").slice(0, 200))}`;
    case 8:
      return "<!-- comment -->";
    case 9:
      return "#document";
    case 11:
      return "#document-fragment";
    default:
      return "[Node]";
  }
}

/** Deserialize a RemoteValue into a JSON-friendly JS value. */
export function remoteToJs(v, seen = 0) {
  if (!v || typeof v !== "object") return v;
  if (seen > 50) return "[…]";
  switch (v.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "boolean":
      return v.value;
    case "number":
      if (typeof v.value === "string") return v.value; // NaN, -0, Infinity
      return v.value;
    case "bigint":
      return `${v.value}n`;
    case "array":
    case "set":
    case "nodelist":
    case "htmlcollection":
      if (!Array.isArray(v.value)) return `[${v.type}]`;
      return v.value.map((x) => remoteToJs(x, seen + 1));
    case "object":
    case "map": {
      if (!Array.isArray(v.value)) return `[${v.type === "map" ? "Map" : "Object"}]`;
      const out = {};
      for (const [k, val] of v.value) {
        const key = typeof k === "string" ? k : String(remoteToJs(k, seen + 1));
        out[key] = remoteToJs(val, seen + 1);
      }
      return out;
    }
    case "date":
      return v.value;
    case "regexp":
      return `/${v.value?.pattern ?? ""}/${v.value?.flags ?? ""}`;
    case "node":
      return nodeSummary(v);
    case "window":
      return "[Window]";
    case "error":
      return "[Error]";
    case "function":
      return "[Function]";
    case "promise":
      return "[Promise]";
    default:
      return `[${v.type}]`;
  }
}

/** Format a RemoteValue for display in a tool result. */
export function formatRemoteValue(v) {
  if (!v) return "undefined";
  if (v.type === "undefined") return "undefined";
  if (v.type === "string") return v.value;
  const js = remoteToJs(v);
  if (typeof js === "string") return js;
  try {
    return JSON.stringify(js, null, 2) ?? "undefined";
  } catch {
    return String(js);
  }
}

/** Build a readable message from BiDi exceptionDetails. */
export function formatException(details) {
  if (!details) return "Unknown error";
  let msg = details.text || "Error";
  const frames = details.stackTrace?.callFrames || [];
  const useful = frames.filter((f) => f.url && !f.url.startsWith("chrome://")).slice(0, 5);
  if (useful.length) {
    msg += "\n" + useful.map((f) => `    at ${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`).join("\n");
  }
  return msg;
}
