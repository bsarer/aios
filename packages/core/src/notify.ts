/**
 * Desktop notifications (S4) through `notify-send`, run without a shell. Notification daemons
 * such as mako read the body as Pango markup, so &, < and > are escaped. If notify-send is
 * missing or fails, nothing happens: the chat message is the record.
 */
import { spawn } from 'node:child_process';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function desktopNotify(title: string, body: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const child = spawn('notify-send', ['--app-name=AI OS', escape(title.slice(0, 100)), escape(body.slice(0, 300))], { env, shell: false, stdio: 'ignore' });
    child.once('error', () => undefined);
    child.unref();
  } catch {
    // No notify-send; the chat message is enough.
  }
}
