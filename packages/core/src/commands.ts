/** Slash commands typed in chat (plan §7). Handled in code; never sent to the model. */

export type Command =
  | { name: 'help' }
  | { name: 'pause' }
  | { name: 'resume' }
  | { name: 'cost' }
  | { name: 'memory' }
  | { name: 'forget'; text: string }
  | { name: 'export' }
  | { name: 'remember'; text: string }
  | { name: 'reindex' }
  | { name: 'checkup' }
  | { name: 'doctor' }
  | { name: 'brief' }
  | { name: 'play'; text: string }
  | { name: 'todos' }
  | { name: 'pin'; text: string }
  | { name: 'unpin'; text: string }
  | { name: 'knowledge'; update: boolean }
  | { name: 'unknown'; raw: string };

/** null when the text is a normal message. */
export function parseCommand(text: string): Command | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const [head = '', ...rest] = t.slice(1).split(/\s+/);
  switch (head.toLowerCase()) {
    case 'help':
      return { name: 'help' };
    case 'pause':
      return { name: 'pause' };
    case 'resume':
      return { name: 'resume' };
    case 'cost':
      return { name: 'cost' };
    case 'memory':
      return { name: 'memory' };
    case 'forget':
      return { name: 'forget', text: rest.join(' ') };
    case 'export':
      return { name: 'export' };
    case 'remember':
      return { name: 'remember', text: rest.join(' ') };
    case 'reindex':
      return { name: 'reindex' };
    case 'checkup':
      return { name: 'checkup' };
    case 'doctor':
      return { name: 'doctor' };
    case 'brief':
      return { name: 'brief' };
    case 'play':
      return { name: 'play', text: rest.join(' ') };
    case 'todos':
    case 'todo':
      return { name: 'todos' };
    case 'pin':
      return { name: 'pin', text: rest.join(' ') };
    case 'unpin':
      return { name: 'unpin', text: rest.join(' ') };
    case 'knowledge':
      return { name: 'knowledge', update: /^(update|now|refresh)$/i.test(rest.join(' ').trim()) };
    default:
      return { name: 'unknown', raw: t };
  }
}

export const HELP_TEXT = [
  'Commands:',
  '/pause   stop the assistant from calling the model or tools',
  '/resume  start again',
  '/cost    what today has cost so far',
  '/remember <text>  offer to remember something (you confirm with Save)',
  '/memory  show everything I remember',
  '/forget <text>  remove a remembered fact',
  '/export  write all memory to one Markdown file',
  '/reindex read your files again for file search, and show how far the index is',
  '/play [name or link]  play your newest video, one whose name contains the words, or an https link, in mpv',
  '/checkup show disk, memory and processor now, and suggest files and windows to tidy up',
  '/doctor  check the install: service, kiosk, Omarchy commands, top bar button, keyring',
  '/brief   show the morning brief now: urgent mail, today\'s events and what is due',
  '/todos   show your open to-dos',
  '/pin <checkup | brief | todos>  pin it as a tile at the bottom of the screen; /unpin takes it off',
  '/knowledge  show the knowledge base Astra keeps about you from your mail, calendar, files and chat',
  '/knowledge update  update it now (it updates by itself every hour)',
  '/help    this list',
  'Keys: Enter sends, Shift+Enter adds a new line, Esc stops a reply.',
].join('\n');
