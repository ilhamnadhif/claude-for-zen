// Give javascript_tool REPL semantics: top-level await works and the value of
// the last expression statement is returned.

import * as acorn from "acorn";

/**
 * Wrap user code in an async IIFE whose result is the last expression's value.
 * Throws a SyntaxError (with location) when the code does not parse.
 * @param {string} code
 * @returns {string} expression suitable for script.evaluate with awaitPromise
 */
export function toReplExpression(code) {
  const source = String(code);
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    });
  } catch (e) {
    const err = new SyntaxError(e.message);
    err.loc = e.loc;
    throw err;
  }

  let body = source;
  const last = ast.body[ast.body.length - 1];
  if (last && last.type === "ExpressionStatement" && !last.directive) {
    const expr = source.slice(last.expression.start, last.expression.end);
    body = `${source.slice(0, last.start)}return (${expr}\n);${source.slice(last.end)}`;
  }
  return `(async () => {\n${body}\n})()`;
}
