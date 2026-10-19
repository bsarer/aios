/**
 * memory_propose (draft tier): shows a "Remember this?" card and writes nothing.
 * The only path to the memory files is Shell.decideMemory, reached by a Save click.
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool } from '../tools/registry.js';
import { cleanFact } from './files.js';
import type { Memory } from './memory.js';

export interface MemoryToolOptions {
  memory: Memory;
  post: (item: ChatItem) => void;
  clock?: () => Date;
  newId?: () => string;
}

export function memoryProposeTool(o: MemoryToolOptions): RegisteredTool {
  const clock = o.clock ?? (() => new Date());
  const newId = o.newId ?? (() => randomUUID());
  return {
    def: toolByName('memory_propose')!,
    label: 'Suggesting something to remember…',
    async handler(args, ctx) {
      const { fact, target = 'facts' } = args as { fact: string; target?: 'facts' | 'profile' };
      const text = cleanFact(fact);
      if (!text) return 'Error: nothing to remember.';
      const known = target === 'facts' ? o.memory.files.facts().some((f) => f.text.toLowerCase() === text.toLowerCase()) : false;
      if (known) return 'Already remembered; nothing to do.';
      o.post({
        kind: 'memory',
        id: newId(),
        text,
        target,
        // Labelled from the context, not from anything the model says about itself.
        source: ctx.untrustedInContext ? 'email' : 'chat',
        state: 'pending',
        at: clock().getTime(),
      });
      return 'A card now asks the user to Save or Skip this. Nothing is saved until they click Save, so do not say it is saved.';
    },
  };
}
