// Rainbow brackets: what counts as a bracket pair and how strictly partners are checked, shared by the syntax
// highlighting worker (file text, diffs) and the code editor. Every text file gets them.

/**
 * Languages where a bracket without a partner is normal, so it isn't marked as an error: prose and markup ("1)" in a
 * list, a smiley), shell case patterns ("a)"), unquoted regexes in config files. Brackets are still colored by depth.
 */
const LENIENT = new Set([
  "plaintext", "markdown", "asciidoc", "latex", "xml", "html", "handlebars", "erb", "diff",
  "bash", "dos", "makefile", "dockerfile", "ini", "properties", "yaml", "nginx", "apache",
]);
/** Whether a bracket without its partner counts as an error in this language (null: unknown, plain text) */
export function strictBrackets(lang: string | null): boolean {
  return !!lang && !LENIENT.has(lang);
}
export const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
export const CLOSE = new Set([")", "]", "}"]);
/** Bracket colors cycle through this many levels */
export const LEVELS = 4;
