/**
 * System clipboard via OSC 52.
 *
 * OSC 52 asks the *terminal emulator* to set the clipboard, which means it
 * works over SSH and inside container shells where there's no local `pbcopy`/
 * `xclip` to call — the bytes ride the same channel as the rest of the TUI's
 * output. The catch is multiplexers: tmux and GNU screen swallow OSC
 * sequences unless you wrap them in their passthrough envelope, so we detect
 * `$TMUX` / `$STY` and wrap accordingly.
 *
 * Terminal support is widespread (iTerm2, kitty, WezTerm, Alacritty, foot,
 * recent xterm) but not universal; there's no reply to confirm, so callers
 * should treat success as best-effort and tell the user what they copied.
 */

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`; // String Terminator

/**
 * Wrap a raw escape sequence so it survives a terminal multiplexer. tmux needs
 * its `\ePtmux;…\e\\` passthrough with every ESC doubled; screen uses a plain
 * DCS passthrough. Outside a multiplexer the sequence is returned unchanged.
 */
function wrapForMultiplexer(sequence: string): string {
  if (process.env.TMUX) {
    return `${ESC}Ptmux;${sequence.split(ESC).join(ESC + ESC)}${ST}`;
  }
  if (process.env.STY) {
    return `${ESC}P${sequence}${ST}`;
  }
  return sequence;
}

/**
 * Build the OSC 52 sequence that sets the clipboard to `text`. The payload is
 * base64-encoded UTF-8 per the spec. Many terminals cap the accepted size
 * (commonly ~75–100 KB after encoding); we leave enforcement to the terminal
 * rather than silently truncating here.
 */
export function buildOsc52(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return wrapForMultiplexer(`${ESC}]52;c;${b64}${BEL}`);
}

/**
 * Copy `text` to the system clipboard via OSC 52. Returns false (a no-op) when
 * stdout isn't a TTY — e.g. piped output — since the sequence would just
 * corrupt the stream. Success is best-effort: there's no acknowledgement.
 */
export function copyToClipboard(
  text: string,
  stdout: NodeJS.WriteStream = process.stdout,
): boolean {
  if (!stdout.isTTY) return false;
  stdout.write(buildOsc52(text));
  return true;
}
