/**
 * Cross-platform browser opener. No npm dependency — uses the OS's native
 * default-app handlers via child_process.
 *
 *   darwin → `open <url>`
 *   win32  → `cmd.exe /c start "" "<url>"`   (empty title required so `start`
 *                                              doesn't interpret a quoted URL
 *                                              as the window title)
 *   linux  → `xdg-open <url>`
 */
import { spawn } from 'node:child_process';

function getOpenCommand(platform) {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: (url) => [url], options: {} };
    case 'win32':
      return {
        command: 'cmd.exe',
        args: (url) => ['/c', 'start', '""', url.replace(/&/g, '^&')],
        options: { windowsVerbatimArguments: true },
      };
    default:
      return { command: 'xdg-open', args: (url) => [url], options: {} };
  }
}

/**
 * Best-effort: opens the URL in the user's default browser. Returns true if
 * the child process was spawned successfully, false if not (caller can fall
 * back to printing the URL for the user to open manually).
 */
export function openBrowser(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('openBrowser requires a non-empty URL string');
  }
  const { command, args, options } = getOpenCommand(process.platform);
  try {
    const child = spawn(command, args(url), {
      detached: true,
      stdio: 'ignore',
      ...options,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
