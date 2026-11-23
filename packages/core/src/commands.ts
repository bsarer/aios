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
  | { name: 'update' }
  | { name: 'settings' }
  | { name: 'clear' }
  | { name: 'brief' }
  | { name: 'play'; text: string }
  | { name: 'music'; text: string }
  | { name: 'signal' }
  | { name: 'web'; text: string }
  | { name: 'todos' }
  | { name: 'pin'; text: string }
  | { name: 'unpin'; text: string }
  | { name: 'knowledge'; update: boolean; check: boolean }
  | { name: 'tone'; text: string }
  | { name: 'wallpaper'; text: string }
  | { name: 'feedback'; list: true }
  | { name: 'feedback'; list: false; text: string }
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
    case 'update':
      return { name: 'update' };
    case 'settings':
    case 'setup':
      return { name: 'settings' };
    case 'clear':
    case 'new':
      return { name: 'clear' };
    case 'brief':
      return { name: 'brief' };
    case 'play':
      return { name: 'play', text: rest.join(' ') };
    case 'music':
      return { name: 'music', text: rest.join(' ') };
    case 'signal':
      return { name: 'signal' };
    case 'web':
      return { name: 'web', text: rest.join(' ') };
    case 'todos':
    case 'todo':
      return { name: 'todos' };
    case 'pin':
      return { name: 'pin', text: rest.join(' ') };
    case 'unpin':
      return { name: 'unpin', text: rest.join(' ') };
    case 'knowledge':
      return { name: 'knowledge', update: /^(update|now|refresh)$/i.test(rest.join(' ').trim()), check: /^check$/i.test(rest.join(' ').trim()) };
    case 'tone':
      return { name: 'tone', text: rest.join(' ') };
    case 'wallpaper':
    case 'background':
      // Keep the path as typed: file names can have runs of spaces.
      return { name: 'wallpaper', text: t.slice(1 + head.length).trim() };
    case 'feedback': {
      // Keep the idea as typed, line breaks included.
      const text = t.slice(1 + head.length).trim();
      return /^list$/i.test(text) ? { name: 'feedback', list: true } : { name: 'feedback', list: false, text };
    }
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
  '/web <link or words>  open a link, or search the web for the words, in Chromium',
  '/music [pause | play | next | previous]  say what is playing in Spotify (or another player), or pause, play or skip it',
  '/signal  whether Signal is connected, and how many messages are unread',
  '/checkup show disk, memory and processor now, and suggest files and windows to tidy up',
  '/doctor  check the install: service, kiosk, Omarchy commands, top bar button, keyring',
  '/update  look for a new version of Astra; Update installs it in a terminal',
  '/brief   show the morning brief now: urgent mail, today\'s events and what is due',
  '/todos   show your open to-dos',
  '/pin <checkup | brief | todos>  pin it as a tile at the bottom of the screen; /unpin takes it off',
  '/knowledge  show the knowledge base Astra keeps about you from your mail, calendar, files and chat',
  '/knowledge update  update it now (it updates by itself every hour)',
  '/knowledge check  look for old commitments, duplicate pages and pages with no links',
  '/tone [friendly | playful | neutral | concise]  show or change how I talk',
  '/wallpaper <sample or picture | off | light | medium | strong>  put a picture behind the chat, take it away, or change how much it is dimmed; /wallpaper samples lists the built-in ones',
  '/settings  open the settings window (the gear at the top does the same); /tone, /pin and /wallpaper change tone, tiles and wallpaper here',
  '/feedback <idea>  save an improvement idea for later; /feedback list shows them all',
  '/clear   clear the chat and start a new conversation (the Clear button at the top does the same; /new too)',
  '/help    this list',
  'Keys: Enter sends, Shift+Enter adds a new line, Up and Down bring back what you sent, Esc stops a reply.',
].join('\n');
