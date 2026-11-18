// Rainbow brackets: what counts as a bracket pair and where they aren't colored, shared by the syntax highlighting
// worker (file text, diffs) and the code editor.

/** Languages whose brackets aren't colored: prose and markup, or where a lone ")" is normal (shell case patterns) */
export const NO_BRACKETS = new Set(["markdown", "xml", "bash", "makefile", "dockerfile", "ini", "yaml"]);
export const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
export const CLOSE = new Set([")", "]", "}"]);
/** Bracket colors cycle through this many levels */
export const LEVELS = 4;
