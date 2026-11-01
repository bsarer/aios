/** The chat window (S3) and how it sits on screen; where apps open (S6). */
import { z } from 'zod';

/**
 * full: the whole screen. orb: a small red circle at the top while an app is open over it.
 * half: the right half, over that app. side (S6): the left half, with an app beside it on the right.
 */
export const WindowMode = z.enum(['full', 'orb', 'half', 'side']);
export type WindowMode = z.infer<typeof WindowMode>;

/**
 * Where an app opens (S6). over: on the chat's screen, the chat becomes the orb (S3).
 * beside: the chat's screen is split, chat on the left and the app on the right.
 * screen: on another screen; the chat stays as it is.
 */
export const AppPlace = z.enum(['over', 'beside', 'screen']);
export type AppPlace = z.infer<typeof AppPlace>;

/** Hyprland output names, e.g. eDP-1, DP-2, HDMI-A-1. Nothing else is ever put in a dispatch. */
export const MONITOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The chat's Wayland app_id, set by the kiosk launcher with --class. */
export const CHAT_APP_CLASS = 'org.aios.home';
/**
 * Window classes that are the chat. Older Chromium builds name --app windows like
 * chrome-127.0.0.1__-Default instead of using --class, so match both.
 */
export const CHAT_CLASS_PATTERN = '^(org\\.aios\\.home|(chrome|chromium|brave)-127\\.0\\.0\\.1__.*)$';
