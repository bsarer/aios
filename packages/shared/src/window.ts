/** The chat window (S3, S7). */

/** Hyprland output names, e.g. eDP-1, DP-2, HDMI-A-1. Nothing else is ever put in a dispatch. */
export const MONITOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The chat's Wayland app_id, set by the kiosk launcher with --class. */
export const CHAT_APP_CLASS = 'org.aios.home';
/**
 * Window classes that are the chat. Older Chromium builds name --app windows like
 * chrome-127.0.0.1__-Default instead of using --class, so match both.
 */
export const CHAT_CLASS_PATTERN = '^(org\\.aios\\.home|(chrome|chromium|brave)-127\\.0\\.0\\.1__.*)$';
