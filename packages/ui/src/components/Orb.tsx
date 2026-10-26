/**
 * The chat while an app is open (S3): core shrinks the window to a small circle at the
 * top of the screen, and this fills it. A click asks for the chat back at half screen.
 */
export function Orb({ working, unseen, onOpen }: { working: boolean; unseen: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="orb"
      title="Open AI OS"
      aria-label="Open AI OS"
      onClick={onOpen}
      className={`orb fixed inset-0 m-auto block aspect-square h-[min(100vw,100vh)] rounded-full${working ? ' orb-working' : ''}`}
    >
      {unseen && <span data-testid="orb-unseen" className="orb-dot" />}
    </button>
  );
}

