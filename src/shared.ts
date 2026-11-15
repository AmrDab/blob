// Constants the host and the page share (no Node imports, so the page can bundle it).

/** The shortcut icons the user picks from; ui/icons.tsx draws each. */
export const ICONS = ['star', 'bolt', 'folder', 'file', 'mail', 'globe', 'music', 'camera', 'gear', 'chat', 'cart', 'heart'] as const;
export const MAX_SHORTCUTS = 12;   // what the + view has room for (two arcs around Speak)
export const MAX_PINNED = 5;       // what the inner arc has room for
/** The liquid-gooey group every blob shares: the bubble, its cards, and clawdcursor's pill. */
export const GOO = { blur: 13.5, contrast: 40, fill: '#e9e9e9', waviness: 8 };
