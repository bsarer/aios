/**
 * Plain-language reasons for mail failures (A7). IMAP (imapflow), SMTP (nodemailer),
 * Node socket and keyring errors all arrive here; the user sees one short sentence.
 * Codes checked against imapflow 2.5.5 and nodemailer 10.1.7.
 */

const NO_NETWORK = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EDNS']);
const REFUSED = new Set(['ECONNREFUSED', 'ECONNECTION']);
const TIMEOUT = new Set(['ETIMEDOUT', 'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT']);
const TLS = new Set([
  'ETLS',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function describeMailError(err: unknown): string {
  const e = (err ?? {}) as { name?: string; code?: string; message?: string; authenticationFailed?: boolean; responseCode?: number };
  if (e.name === 'KeyringError') return "the mail password isn't readable from the keyring (it may still be locked, or run `pnpm run setup`)";
  if (e.authenticationFailed || e.code === 'EAUTH' || e.code === 'ENOAUTH' || e.responseCode === 535) {
    return 'the mail server rejected the login. Check the app password with `pnpm run setup`';
  }
  if (e.code && NO_NETWORK.has(e.code)) return "the mail server can't be found. Check the network connection";
  if (e.code && REFUSED.has(e.code)) return 'the mail server refused the connection. Check the host and port in your config';
  if (e.code && TIMEOUT.has(e.code)) return 'the mail server took too long to answer';
  if (e.code && TLS.has(e.code)) return "the mail server's security certificate couldn't be verified";
  if (e.code === 'ETHROTTLE') return 'the mail server is limiting how often we connect';
  if (e.code === 'ECONNRESET' || e.code === 'EPIPE' || e.code === 'ESOCKET') return 'the connection to the mail server dropped';
  if (e.code === 'EENVELOPE') return 'the mail server refused one of the recipients';
  return (e.message ?? 'unknown error').slice(0, 200);
}
