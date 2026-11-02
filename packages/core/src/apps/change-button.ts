/**
 * The "Change this app" button AI OS adds to every app it builds (S5). It is a small floating
 * button in a closed shadow root, so the app's own styles can't reach it. Clicking it opens a
 * box where the user says what should change; the words go to aios-core's /app-link/change,
 * which only posts a Change card in the chat. Nothing is built until the user clicks Change on
 * that card in AI OS itself, because the app's own code shares this page and could press any
 * button in it. While the card waits or the change runs, the box shows where it is, and the
 * app reloads itself when the change is done.
 *
 * The block sits between two markers so it can be taken out and put back after every build
 * (Claude Code edits index.html and may move or drop it). Only the app's slug, its link
 * token and the port go into it, all checked against strict patterns first.
 */

export interface ChangeLink {
  port: number;
  slug: string;
  /** The app's link token (link.ts): hex, proves a request came from this app's page. */
  token: string;
}

const START = '<!-- AI OS: change button -->';
const END = '<!-- /AI OS: change button -->';
const BLOCK = /<!-- AI OS: change button -->[\s\S]*?<!-- \/AI OS: change button -->/g;

/** The path prefix the app's policy lets it reach, and nothing else. */
export const LINK_PATH = '/app-link/';
export const linkOrigin = (port: number) => `http://127.0.0.1:${port}`;

/** index.html without AI OS's change button. */
export function withoutChangeButton(html: string): string {
  return html.replace(BLOCK, '');
}

function check(link: ChangeLink): void {
  if (!Number.isInteger(link.port) || link.port < 1 || link.port > 65_535) throw new Error('bad port');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(link.slug)) throw new Error('bad app slug');
  if (!/^[0-9a-f]{64}$/.test(link.token)) throw new Error('bad link token');
}

/** index.html with exactly one change button, just before </body> (or at the end). */
export function withChangeButton(html: string, link: ChangeLink): string {
  check(link);
  const stripped = withoutChangeButton(html);
  const block = `${START}<script>${script(link)}</script>${END}`;
  const at = stripped.toLowerCase().lastIndexOf('</body>');
  return at >= 0 ? `${stripped.slice(0, at)}${block}${stripped.slice(at)}` : `${stripped}${block}`;
}

/** The script, as one line. Plain ES2017 with no imports; values are JSON-encoded. */
function script(link: ChangeLink): string {
  const cfg = JSON.stringify({ base: `${linkOrigin(link.port)}${LINK_PATH}`, slug: link.slug, token: link.token });
  // Kept free of "</" so it can't close its own <script> tag.
  return `(function(){var C=${cfg};${BODY}})();`;
}

const CSS = [
  ':host{all:initial;position:fixed;right:14px;bottom:14px;z-index:2147483647;font:14px/1.4 system-ui,sans-serif;color-scheme:light dark}',
  'button{font:inherit;cursor:pointer;border-radius:999px;border:1px solid #8885;padding:6px 12px;background:Canvas;color:CanvasText}',
  '#open{opacity:.55;box-shadow:0 2px 8px #0003}',
  '#open:hover,#open:focus-visible{opacity:1}',
  '#box{display:none;width:320px;max-width:calc(100vw - 28px);padding:12px;border-radius:12px;border:1px solid #8885;background:Canvas;color:CanvasText;box-shadow:0 6px 24px #0004}',
  ':host(.open) #box{display:block}',
  ':host(.open) #open{display:none}',
  'textarea{box-sizing:border-box;width:100%;min-height:84px;margin:6px 0;font:inherit;padding:6px;border-radius:8px;border:1px solid #8886;background:Field;color:FieldText;resize:vertical}',
  '#row{display:flex;gap:8px;justify-content:flex-end}',
  '#send{background:#d33;border-color:#d33;color:#fff}',
  '#send:disabled{opacity:.5;cursor:default}',
  '#say{margin:6px 0 0;white-space:pre-wrap}',
  'h2{font-size:14px;margin:0}',
].join('');

/**
 * The button's behaviour. Uses textContent only (never innerHTML) for anything it shows.
 * `C` is { base, slug, token }.
 */
const BODY = [
  'if(window.__aiosChange)return;window.__aiosChange=1;',
  "var host=document.createElement('aios-change');",
  "var root=host.attachShadow({mode:'closed'});",
  `var st=document.createElement('style');st.textContent=${JSON.stringify(CSS)};root.appendChild(st);`,
  "function el(t,id,txt){var e=document.createElement(t);if(id)e.id=id;if(txt)e.textContent=txt;return e;}",
  "var open=el('button','open','\\u270e Change this app');open.title='Ask AI OS to change this app';",
  "var box=el('div','box');var h=el('h2','','What should change?');",
  "var ta=el('textarea');ta.maxLength=2000;ta.placeholder='For example: make the cards bigger, or add an undo button';",
  "var row=el('div','row');var close=el('button','close','Close');var send=el('button','send','Send to AI OS');",
  "var say=el('p','say');",
  "row.appendChild(close);row.appendChild(send);box.appendChild(h);box.appendChild(ta);box.appendChild(row);box.appendChild(say);",
  'root.appendChild(open);root.appendChild(box);',
  'var timer=0,card=null;',
  "function show(t){say.textContent=t||'';}",
  "open.onclick=function(){host.classList.add('open');ta.focus();};",
  "close.onclick=function(){host.classList.remove('open');};",
  // Keys typed in the box stay in the box, so the app (a game, say) doesn't act on them.
  "['keydown','keyup','keypress'].forEach(function(k){box.addEventListener(k,function(e){e.stopPropagation();if(k==='keydown'&&e.key==='Escape')host.classList.remove('open');});});",
  'function post(path,data){return fetch(C.base+path,{method:"POST",body:JSON.stringify(data),cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"}).then(function(r){return r.json();});}',
  'function poll(){post("status",{slug:C.slug,token:C.token,card:card}).then(function(r){',
  "if(r.state==='done'){show('Done. Reloading with your changes\\u2026');clearInterval(timer);setTimeout(function(){location.reload();},800);return;}",
  "if(r.state!=='pending'&&r.state!=='running'){clearInterval(timer);send.disabled=false;}",
  'show(r.message||"");',
  "}).catch(function(){});}",
  "send.onclick=function(){var t=ta.value.trim();if(!t){show('Say what should change first.');return;}",
  "send.disabled=true;show('Sending\\u2026');",
  'post("change",{slug:C.slug,token:C.token,request:t}).then(function(r){',
  "if(!r.ok){send.disabled=false;show(r.message||'AI OS could not take that.');return;}",
  "card=r.card;ta.value='';show(r.message);clearInterval(timer);timer=setInterval(poll,3000);",
  "}).catch(function(){send.disabled=false;show('AI OS isn\\u2019t answering. Is it running?');});};",
  "function add(){(document.body||document.documentElement).appendChild(host);}",
  "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',add);else add();",
].join('');
