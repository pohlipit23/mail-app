import { readFileSync } from "fs";
import { execFile } from "child_process";
import { shell } from "electron";
import { createLogger } from "./logger";

const log = createLogger("wsl");

let _isWSL: boolean | null = null;

/**
 * Detect whether we're running inside Windows Subsystem for Linux.
 * Checks /proc/version for the "microsoft" or "WSL" markers that the
 * WSL2 kernel always includes.
 */
export function isWSL(): boolean {
  if (_isWSL !== null) return _isWSL;
  try {
    const version = readFileSync("/proc/version", "utf8");
    _isWSL = /microsoft|wsl/i.test(version);
  } catch {
    _isWSL = false;
  }
  return _isWSL;
}

/**
 * Open a URL in the user's browser, routing through the Windows host
 * browser when running under WSL.
 *
 * In WSL2, Electron's shell.openExternal() calls xdg-open, which usually
 * has no Windows browser registered. We use cmd.exe (always available in
 * WSL2) to invoke the Windows `start` command instead.
 *
 * OAuth callbacks to localhost work because WSL2 forwards localhost from
 * the Windows host to the WSL instance by default.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isWSL()) {
    await shell.openExternal(url);
    return;
  }

  log.info("WSL detected — opening URL via Windows host browser");
  return new Promise<void>((resolve, reject) => {
    // cmd.exe /c start opens the URL in the Windows default browser.
    // The empty "" is a title argument that `start` requires when the
    // target contains special characters (like &= in OAuth URLs).
    execFile("cmd.exe", ["/c", "start", "", url.replace(/&/g, "^&")], (error: Error | null) => {
      if (error) {
        log.warn(`cmd.exe start failed, falling back to shell.openExternal: ${error.message}`);
        shell.openExternal(url).then(resolve, reject);
      } else {
        resolve();
      }
    });
  });
}
