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
  '/help    this list',
  'Keys: Enter sends, Shift+Enter adds a new line, Esc stops a reply.',
].join('\n');
