/** Opens a URL in the user's default browser — fire-and-forget, no terminal needed.
 *  Lives in its own module so dashboard tests can stub it without launching a browser. */
export function openUrl(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    /* no opener available — the URL is still visible on screen to copy */
  }
}
