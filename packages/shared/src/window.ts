/** The chat window (S3) and how it sits on screen. */
import { z } from 'zod';

/** full: the whole screen. hidden: out of sight while an app is open, with a red circle in the bar's tray. half: the right half, over the app. */
export const WindowMode = z.enum(['full', 'hidden', 'half']);
export type WindowMode = z.infer<typeof WindowMode>;

/** The chat's Wayland app_id, set by the kiosk launcher with --class. */
export const CHAT_APP_CLASS = 'org.aios.home';
/**
 * Window classes that are the chat. Older Chromium builds name --app windows like
 * chrome-127.0.0.1__-Default instead of using --class, so match both.
 */
export const CHAT_CLASS_PATTERN = '^(org\\.aios\\.home|(chrome|chromium|brave)-127\\.0\\.0\\.1__.*)$';

/** The tray icon's Id (StatusNotifierItem Id), which Omarchy's bar pins by. */
export const TRAY_ITEM_ID = 'aios';
