/** Windows CommandLineToArgvW-compatible quoting for ordinary executable arguments.
 * Used only to inspect version-bound process identity, never to execute a shell.
 */
export function splitWindowsCommandLine(text: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (/\s/.test(text[i] ?? "") && i < text.length) i++;
    if (i >= text.length) break;
    let value = "",
      quoted = false;
    while (i < text.length && (quoted || !/\s/.test(text[i]))) {
      if (text[i] === "\\") {
        let n = 0;
        while (text[i] === "\\") {
          n++;
          i++;
        }
        if (text[i] === '"') {
          value += "\\".repeat(Math.floor(n / 2));
          if (n % 2) {
            value += '"';
            i++;
          } else {
            quoted = !quoted;
            i++;
          }
        } else value += "\\".repeat(n);
      } else if (text[i] === '"') {
        quoted = !quoted;
        i++;
      } else value += text[i++];
    }
    if (quoted) throw new Error("Unterminated Windows process argument.");
    args.push(value);
  }
  return args;
}
