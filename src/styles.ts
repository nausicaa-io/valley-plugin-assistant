import providersCss from './ProvidersSettings.css'
import usageCss from './UsageSettings.css'
import chartsCss from './charts/Charts.css'
import loadingCss from './charts/core/shells/LoadingCircle.css'
/**
 * Plugin styles, injected once. Uses the real Notes design tokens
 * (src/renderer/src/styles/tokens.css) so the assistant matches the app under
 * both light and dark themes — never invents variable names.
 */
const STYLE_ID = 'assistant-plugin-styles'

const CSS = `
.assistant-panel { display:flex; flex-direction:column; height:100%; gap:8px; padding:5px; box-sizing:border-box; }
/* Layout only — the frame, height and title come from the shared .panel-header.
   The panel pads itself by 5px, so its header has to reach back out to the edge. */
.assistant-panel-head { margin:-5px -5px 0; box-sizing:border-box; }
.assistant-ico { color:var(--text-secondary); flex:0 0 auto; }
.assistant-quick { display:flex; flex-direction:column; gap:6px; }
.assistant-quick-input, .assistant-composer-input, .assistant-input, .assistant-textarea, .assistant-select {
  background:var(--surface-color); color:var(--text-color); border:1px solid var(--border-medium);
  border-radius:8px; padding:6px 8px; font:inherit; resize:vertical; box-sizing:border-box; width:100%;
}
.assistant-select { width:auto; }
/* Model/parser pickers are the shared SelectField: it owns border, background
   and caret, so the plugin rule above must not also paint them. */
.assistant-input.select-field { width:100%; min-height:32px; padding:6px 8px; }
.assistant-textarea.assistant-mono { font-family:var(--mono-font); font-size:var(--smaller-font-size); }
.assistant-thread-list { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:2px; }
.assistant-thread-row { display:flex; align-items:center; justify-content:space-between; gap:6px;
  padding:6px 8px; border-radius:8px; cursor:pointer; color:var(--text-color); }
.assistant-thread-row:hover { background:var(--hover-bg); }
.assistant-thread-row.active { background:var(--accent-tint-bg); color:var(--accent-tint-text); }
.assistant-thread-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; font-size:0.8125rem; }
.assistant-thread-del { opacity:0; }
.assistant-thread-row:hover .assistant-thread-del { opacity:1; }
.assistant-empty, .assistant-welcome { color:var(--text-secondary); font-size:0.8125rem; padding:8px; }
.assistant-iconbtn { background:none; border:none; color:var(--text-secondary); cursor:pointer; padding:4px;
  border-radius:6px; display:inline-flex; }
.assistant-iconbtn:hover { background:var(--hover-bg); color:var(--text-color); }
.assistant-btn { display:inline-flex; align-items:center; gap:6px; background:var(--accent-color); color:#fff;
  border:none; border-radius:8px; padding:6px 12px; cursor:pointer; font:inherit; }
.assistant-btn:disabled { opacity:.5; cursor:default; }
.assistant-btn-sm { padding:4px 10px; font-size:0.75rem; }
.assistant-btn-ghost { background:var(--surface-color); color:var(--text-color); border:1px solid var(--border-medium); }
.assistant-btn-ghost:hover:not(:disabled) { border-color:var(--accent-color); color:var(--accent-color); }
.assistant-stop { background:var(--container-color-alt); color:var(--text-color); border:1px solid var(--border-medium); }
.assistant-quiz-choices { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 4px; }
.assistant-quiz-choices .assistant-btn { min-width:44px; justify-content:center; }

.assistant-page { display:flex; flex-direction:column; height:100%; box-sizing:border-box; background:var(--container-color-alt);
  container-type:inline-size; container-name:assistant-page; }
.assistant-page-head { display:flex; align-items:center; justify-content:space-between; gap:12px;
  height:var(--app-bar-height); flex:0 0 auto; padding:0 calc(var(--plugin-actions-offset, 0px) + 18px) 0 18px; border-bottom:1px solid var(--border-light); background:var(--container-color-alt); }
.assistant-page-title-wrap { min-width:0; display:flex; flex-direction:column; gap:1px; margin-left:var(--plugin-navigation-offset, 0px); }
.assistant-page-title { display:flex; align-items:center; gap:7px; font-weight:650; color:var(--title-color);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.25; }
.assistant-page-subtitle { font-size:0.6875rem; color:var(--text-tertiary); }
.assistant-live-pill { display:inline-flex; align-items:center; flex:0 0 auto; height:24px; padding:0 9px;
  border:1px solid var(--border-light); border-radius:999px; background:var(--surface-color); color:var(--text-secondary);
  font-size:0.75rem; }
.assistant-page-controls { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.assistant-routebar { padding:4px 14px; font-size:0.6875rem; color:var(--text-secondary); border-bottom:1px solid var(--border-light); }
.assistant-route-reason { opacity:.7; }
.assistant-messages { flex:1; overflow-y:auto; padding:18px clamp(16px,4cqi,48px);
  display:flex; flex-direction:column; gap:16px; scroll-behavior:smooth; }
/* No centered reading column: assistant text + tool blocks always start at the
   far left (full width), user bubbles always hug the right. */
.assistant-msg { display:flex; flex-direction:column; gap:4px; width:100%;
  animation:assistant-message-in 180ms var(--ease-out); }
.assistant-msg.mine { align-items:flex-end; }
.assistant-msg.theirs { align-items:flex-start; }
.assistant-bubble { white-space:pre-wrap; word-break:break-word; color:var(--text-color); font-family:var(--body-font);
  font-size:0.875rem; line-height:1.6; background:transparent; padding:0; border-radius:0; border:none; }
.assistant-msg.mine .assistant-bubble {
  /* Opaque tint (NOT translucent --accent-tint-bg): a see-through fill makes the
     overlapping tail double up into a darker shard. This pre-mixed colour matches
     the tint visually in both themes while letting the tail merge seamlessly. */
  --assistant-bubble-bg: color-mix(in srgb, var(--accent-color) 16%, var(--container-color-alt));
  position: relative;
  background: var(--assistant-bubble-bg);
  color: var(--text-color);
  border-radius: 18px 18px 6px 18px;
  padding: 7px 13px;
  max-width: 78%;
}
.assistant-msg.mine .assistant-bubble::after {
  content: '';
  position: absolute;
  right: -5px;
  bottom: 0;
  width: 15px;
  height: 15px;
  background: var(--assistant-bubble-bg);
  pointer-events: none;
  clip-path: polygon(0 0, 0 100%, 100% 100%);
  border-bottom-left-radius: 13px;
}
/* Copy + timestamp shown once, at the end of an assistant turn. The row reserves
   its height (placeholder) so revealing the controls on hover never shifts the
   layout below. */
.assistant-msg-meta { display:flex; align-items:center; gap:6px; min-height:20px; margin-top:2px; padding:0 2px; }
/* My own (right-aligned) messages mirror the meta row → date then copy, copy nearest the edge. */
.assistant-msg.mine .assistant-msg-meta { flex-direction:row-reverse; }
.assistant-msg-meta > * { opacity:0; transition:opacity 120ms var(--ease-out); }
.assistant-msg:hover .assistant-msg-meta > *, .assistant-msg-meta:focus-within > * { opacity:1; }
.assistant-copy-btn { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
  padding:0; border:none; border-radius:6px; background:transparent; color:var(--text-secondary); cursor:pointer;
  transition:background 120ms var(--ease-out), color 120ms var(--ease-out); }
.assistant-copy-btn:hover { background:var(--hover-bg); color:var(--text-color); }
.assistant-copy-btn:focus { outline:none; }
.assistant-copy-btn:focus-visible { outline:2px solid var(--accent-color); outline-offset:1px; }
.assistant-copy-icon { width:13px; height:13px; }
.assistant-msg-time { font-size:0.6875rem; color:var(--text-secondary); user-select:none; }
.assistant-wikilink, .assistant-bubble-md a.wikilink { color:var(--accent-color); text-decoration:none;
  border-bottom:1px solid color-mix(in srgb, var(--accent-color) 40%, transparent); cursor:pointer; font-weight:500; }
.assistant-wikilink:hover, .assistant-bubble-md a.wikilink:hover { background:var(--accent-tint-bg); }
/* Rendered Markdown inside a chat bubble: reset the bubble's pre-wrap, tighten the
 * shared .markdown-body rhythm so blocks sit snug in the small bubble. */
.assistant-bubble-md { white-space:normal; }
.assistant-bubble-md > :first-child { margin-top:0; }
.assistant-bubble-md > :last-child { margin-bottom:0; }
.assistant-bubble-md p { margin:0 0 8px; }
.assistant-bubble-md p:last-child { margin-bottom:0; }
.assistant-bubble-md ul, .assistant-bubble-md ol { margin:4px 0; padding-left:20px; }
.assistant-bubble-md li { margin:1px 0; }
.assistant-bubble-md h1, .assistant-bubble-md h2, .assistant-bubble-md h3,
.assistant-bubble-md h4, .assistant-bubble-md h5, .assistant-bubble-md h6 { margin:8px 0 4px; line-height:1.3; }
.assistant-bubble-md pre { margin:6px 0; padding:8px 10px; border-radius:8px; overflow:auto;
  background:var(--container-color-alt); border:1px solid var(--border-light); font:12px/1.5 var(--mono-font); }
.assistant-bubble-md code { font:12px/1.5 var(--mono-font); }
.assistant-bubble-md :not(pre) > code { padding:1px 4px; border-radius:4px; background:var(--container-color-alt); }
.assistant-bubble-md blockquote { margin:6px 0; padding:2px 0 2px 10px; border-left:3px solid var(--border-medium);
  color:var(--text-secondary); }
.assistant-bubble-md table { border-collapse:collapse; margin:6px 0; font-size:0.78125rem; }
.assistant-bubble-md th, .assistant-bubble-md td { border:1px solid var(--border-light); padding:4px 8px; }
.assistant-bubble-md a { color:var(--accent-color); }
.assistant-msg.mine .assistant-bubble-md pre,
.assistant-msg.mine .assistant-bubble-md :not(pre) > code {
  background: color-mix(in srgb, var(--container-color) 60%, transparent);
}
.assistant-bubble-image { display:block; max-width:100%; max-height:320px; margin:6px 0 2px; border-radius:10px;
  border:1px solid var(--border-light); cursor:pointer; }
.assistant-bubble-image:hover { border-color:var(--accent-color); }
.assistant-attach-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; }
.assistant-attach-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:8px;
  background:var(--container-color-alt); border:1px solid var(--border-light); color:var(--text-secondary); font-size:0.75rem; }
.assistant-attach-chip button { background:none; border:none; color:var(--text-secondary); cursor:pointer; padding:0; line-height:1; }
.assistant-attach-chip button:hover { color:var(--accent-color); }
.assistant-attach-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; flex:0 0 auto;
  border-radius:8px; border:none; background:transparent; color:var(--text-secondary); cursor:pointer; }
.assistant-attach-btn:hover:not(:disabled) { color:var(--text-color); background:var(--hover-bg); }
.assistant-attach-btn:disabled { opacity:.4; cursor:default; }
/* Hand-icon permission control + popover (Claude-style) in the composer toolbar. */
.assistant-perm { position:relative; display:inline-flex; flex:0 0 auto; }
.assistant-hand-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; flex:0 0 auto;
  border-radius:8px; border:none; background:transparent; color:var(--text-secondary); cursor:pointer; }
.assistant-hand-btn:hover:not(:disabled) { color:var(--text-color); background:var(--hover-bg); }
.assistant-hand-btn:disabled { opacity:.4; cursor:default; }
.assistant-hand-btn.is-open { color:var(--text-secondary); }
/* Self-contained chrome — intentionally NOT sharing .assistant-menu, whose
   position:fixed (declared later in this sheet) would override these and push the
   popover off-screen, and whose button/svg rules would out-specify the perm items. */
.assistant-perm-menu { position:absolute; bottom:100%; left:0; margin-bottom:6px; min-width:240px; max-width:300px;
  z-index:1001; padding:4px; background:var(--surface-color); border:1px solid var(--border-light);
  border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,.12); }
.assistant-perm-item { display:flex; align-items:flex-start; gap:9px; width:100%; padding:7px 9px; background:none;
  border:none; border-radius:7px; color:var(--text-color); font:inherit; text-align:left; cursor:pointer; }
.assistant-perm-item:hover { background:var(--hover-bg); }
.assistant-perm-ico { display:inline-flex; flex:0 0 auto; margin-top:1px; color:var(--text-tertiary); }
.assistant-perm-ico svg { width:15px; height:15px; }
.assistant-perm-chevrons { font-size:15px; line-height:1; font-weight:700; width:15px; justify-content:center; }
.assistant-perm-text { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.assistant-perm-label { font-size:0.8125rem; font-weight:600; color:var(--text-color); }
.assistant-perm-desc { font-size:0.71875rem; line-height:1.35; color:var(--text-secondary); white-space:normal; }
.assistant-perm-check { width:14px; height:14px; flex:0 0 auto; margin-top:2px; color:var(--accent-color); }
.assistant-perm-item.is-danger .assistant-perm-ico,
.assistant-perm-item.is-danger .assistant-perm-label { color:var(--accent-color); }
.assistant-hand-btn.is-danger { color:var(--accent-color); }
.assistant-composer.is-drop { border-color:var(--accent-color); box-shadow:0 0 0 2px var(--accent-tint-bg); }
.assistant-streaming { position:relative; }
.assistant-stream-caret { display:inline-block; width:6px; height:1.1em; margin-left:2px; vertical-align:-2px;
  border-right:2px solid var(--accent-color); animation:assistant-stream-blink 1s steps(2,start) infinite; }
.assistant-run-status { width:100%; align-self:flex-start; display:flex; align-items:flex-start;
  padding:4px 0; color:var(--text-secondary); animation:assistant-message-in 180ms var(--ease-out); }
.assistant-run-label { color: var(--text-tertiary); font-size:0.8125rem; font-weight: 400; }
.assistant-run-sub { display: none; }
.assistant-think-dots::after {
  content: '';
  animation: assistant-think-dots 1.2s steps(4, end) infinite;
}
@keyframes assistant-think-dots {
  0%   { content: ''; }
  25%  { content: '.'; }
  50%  { content: '..'; }
  75%  { content: '...'; }
  100% { content: ''; }
}
@keyframes assistant-message-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
@keyframes assistant-stream-blink { 0%,45% { opacity:1; } 46%,100% { opacity:0; } }
.assistant-tg-ico { color:#2aabee; flex:0 0 auto; }
.assistant-wa-ico { color:#25d366; flex:0 0 auto; }
.assistant-activity { width:100%; align-self:flex-start; color:var(--text-secondary);
  animation:assistant-message-in 180ms var(--ease-out); }
/* Group an assistant turn (text + tool steps + more text) tightly, while the
   16px flex gap still separates distinct user/assistant turns. */
.assistant-msg.theirs + .assistant-activity,
.assistant-activity + .assistant-activity,
.assistant-activity + .assistant-msg.theirs { margin-top:-8px; }
.assistant-activity summary { list-style:none; display:flex; align-items:flex-start; gap:7px; min-height:22px;
  padding:2px 0; border:none; border-radius:0; background:transparent; cursor:pointer; user-select:none;
  box-sizing:border-box; }
.assistant-activity-text { display:flex; flex-direction:row; align-items:baseline; gap:5px; min-width:0; flex:1; }
.assistant-activity summary::-webkit-details-marker { display:none; }
.assistant-activity summary:hover .assistant-activity-title { color:var(--title-color); }
.assistant-activity[open] summary { border:none; border-radius:0; }
.assistant-activity-caret { width:12px; height:12px; margin-top:3px; flex:0 0 auto; color:var(--text-tertiary); transition:transform var(--duration-fast) var(--ease-out); }
.assistant-activity[open] .assistant-activity-caret { transform:rotate(90deg); }
/* Title never shrinks (shown in full); only the parenthetical meta ellipsizes.
   max-width:100% caps the title so that IF it alone exceeds the row it still
   ellipsizes instead of overflowing — at which point the meta is squeezed to 0. */
.assistant-activity-title { flex:0 0 auto; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--text-tertiary); font-size:0.78125rem; font-weight:400; }
.assistant-activity-meta { min-width:0; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--text-tertiary); font-size:0.75rem; }
.assistant-activity-body { position:relative; display:flex; flex-direction:column; gap:0; padding:4px 0 2px 26px;
  border:none; border-radius:0; background:transparent; }
.assistant-activity-step { position:relative; padding:6px 0 11px 6px; border:none; border-radius:0; background:transparent; }
/* Connector runs icon-center → next-icon-center: only downward from each node, so
   no line ever sits above the first icon, and the last node (Done) has none below.
   left:-14px aligns to the icon center; top/bottom:15px is the 16px icon's half-height. */
.assistant-activity-step:not(:last-child)::before { content:''; position:absolute; left:-14px; top:15px; bottom:-15px;
  width:1px; background:var(--border-medium); }
.assistant-activity-step-head { display:flex; align-items:center; gap:8px; min-width:0; }
.assistant-activity-step-ico { position:absolute; left:-22px; top:7px; width:16px; height:16px;
  display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; color:var(--text-tertiary);
  background:var(--container-color-alt); }
.assistant-activity-step-ico svg { width:13px; height:13px; }
.assistant-activity-step-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--title-color); font-size:0.78125rem; font-weight:600; }
/* Terminal "Done" node — a quiet end-cap; the check inherits the same gray
   (--text-tertiary) and 13px size as every other step glyph, so it blends in. */
.assistant-activity-done .assistant-activity-step-title { color:var(--text-secondary); font-weight:500; }
.assistant-activity-args { margin:7px 0 0; padding:8px; max-height:180px; overflow:auto; border:1px solid var(--border-light);
  border-radius:6px; background:var(--container-color-alt); color:var(--text-secondary); white-space:pre-wrap;
  word-break:break-word; font:11px/1.45 var(--mono-font); }
.assistant-activity-output { margin-top:5px; padding:0; max-height:240px; overflow:auto; border:none; border-radius:0;
  background:transparent; color:var(--text-secondary); white-space:pre-wrap; word-break:break-word;
  font-size:0.78125rem; line-height:1.5; }
.assistant-approval { align-self:stretch; background:var(--accent-tint-bg); border:1px solid var(--accent-color);
  border-radius:8px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
.assistant-approval-text { color:var(--text-color); font-size:0.8125rem; }
.assistant-approval-target { color:var(--text-secondary); }
.assistant-approval-args { margin:6px 0 0; padding:8px 10px; border-radius:6px; background:var(--container-color-alt);
  font-family:var(--mono-font); font-size:var(--smaller-font-size); color:var(--text-secondary); white-space:pre-wrap; word-break:break-word; }
.assistant-approval-actions { display:flex; flex-wrap:wrap; gap:8px; }
.assistant-approval-details > summary { cursor:pointer; font-size:0.75rem; color:var(--text-secondary); }
.assistant-btn-danger { color:var(--accent-color); }
/* Temporary permission bypass ("dangerous mode") — always-visible elevated state. */
.assistant-danger-chip { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:999px;
  border:1px solid var(--accent-color); background:var(--accent-tint-bg); color:var(--accent-color);
  font-size:0.6875rem; font-weight:600; cursor:pointer; }
.assistant-danger-chip:hover { background:var(--accent-color); color:#fff; }
.assistant-composer.is-dangerous { border-color:var(--accent-color); box-shadow:0 0 0 2px var(--accent-tint-bg), 0 8px 26px rgba(0,0,0,.08); }
.assistant-danger-warning { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:10px;
  background:var(--accent-tint-bg); border:1px solid var(--accent-color); color:var(--accent-color);
  font-size:0.75rem; font-weight:600; }
.assistant-danger-off { margin-left:auto; padding:2px 8px; border-radius:6px; border:1px solid var(--accent-color);
  background:transparent; color:var(--accent-color); font:inherit; font-size:0.6875rem; cursor:pointer; }
.assistant-danger-off:hover { background:var(--accent-color); color:#fff; }
/* Claude-style composer: a rounded card holding the input + an inline toolbar. */
.assistant-composer { display:flex; flex-direction:column; gap:7px; margin:10px clamp(16px,4cqi,48px) 16px;
  padding:8px 10px; border:1px solid var(--border-medium); border-radius:16px; background:var(--surface-color);
  box-shadow:0 6px 20px rgba(0,0,0,.06); }
.assistant-composer:focus-within { border-color:var(--accent-color); }
.assistant-composer.is-streaming { opacity:.95; }
.assistant-composer-input { width:100%; border:none; background:transparent; padding:2px 2px 0; resize:none;
  color:var(--text-color); font:inherit; line-height:1.45; min-height:24px; max-height:220px; overflow-y:auto; }
.assistant-composer-input:focus { outline:none; }
.assistant-composer-toolbar { display:flex; align-items:center; gap:8px; }
.assistant-composer-left { display:flex; align-items:center; gap:6px; flex:0 0 auto; margin-right:auto; }
.assistant-composer-right { display:flex; align-items:center; gap:6px; min-width:0; }
.assistant-model-wrap { display:flex; align-items:center; gap:1px; min-width:0; }
/* Borderless model picker (plain text + chevron). field-sizing:content makes the
   control hug the selected text — only as wide as the text + 3px side padding. */
.assistant-model-select { field-sizing:content; background:transparent; border:none; border-radius:6px; padding:3px;
  color:var(--text-secondary); font:inherit; font-size:0.75rem; cursor:pointer; max-width:160px; min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; -webkit-appearance:none; -moz-appearance:none; appearance:none; }
.assistant-model-select:hover { color:var(--text-color); }
.assistant-model-chevron { width:13px; height:13px; flex:0 0 auto; color:var(--text-tertiary); pointer-events:none; }
.assistant-route-caption { font-size:0.6875rem; color:var(--text-secondary); opacity:.8; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.assistant-send-round { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center;
  width:32px; height:32px; border-radius:50%; border:none; background:var(--accent-color); color:#fff; cursor:pointer; }
.assistant-send-round:disabled { opacity:.4; cursor:default; }
.assistant-send-stop { background:var(--container-color-alt); color:var(--text-color); border:1px solid var(--border-medium); }

.assistant-channel-banner { display:flex; align-items:center; gap:8px; margin:10px clamp(16px,4cqi,48px) 16px; padding:9px 10px;
  border:1px solid var(--border-light); border-radius:8px; background:var(--container-color); color:var(--text-secondary); font-size:0.78125rem;
  min-width:0; }
.assistant-channel-banner span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
/* Inside the remote composer the banner is a header line, not a standalone card —
   the composer already carries the page's horizontal inset. */
.assistant-composer-channel > .assistant-channel-banner { margin:0 0 8px; }

/* Width-responsive layout keyed to the chat's OWN width (container query), so a
   narrow pane / sidebar reflows the same as a narrow window — a viewport @media
   can't see a narrow pane inside a wide window. cqi units track inline size too. */
@container assistant-page (max-width:720px) {
  .assistant-messages { padding:14px 12px; }
  .assistant-msg, .assistant-msg.mine, .assistant-activity, .assistant-run-status { max-width:100%; width:auto; }
  .assistant-activity-meta { max-width:100%; }
  .assistant-composer, .assistant-channel-banner { margin-left:12px; margin-right:12px; }
}

/* Phone-width tier: squeeze chrome so nothing clips at sidebar widths. */
@container assistant-page (max-width:460px) {
  .assistant-page-head { padding:0 12px; gap:8px; }
  .assistant-messages { padding:12px 10px; gap:10px; }
  .assistant-msg, .assistant-msg.mine, .assistant-activity, .assistant-run-status { max-width:100%; }
  .assistant-bubble { font-size:0.8125rem; }
  .assistant-msg.mine .assistant-bubble { padding:7px 11px; border-radius:14px; }
  .assistant-composer { margin-left:10px; margin-right:10px; padding:8px 10px; border-radius:14px; }
  .assistant-channel-banner { margin-left:10px; margin-right:10px; }
  .assistant-composer-toolbar { flex-wrap:wrap; row-gap:6px; }
  .assistant-composer-right { flex:1 1 auto; justify-content:flex-end; }
  .assistant-model-select { max-width:108px; }
  .assistant-route-caption { display:none; }
  .assistant-perm-menu { min-width:200px; }
}

/* Fallback for engines without container-query support: track the viewport. */
@supports not (container-type:inline-size) {
  @media (max-width:720px) {
    .assistant-messages { padding:14px 12px; }
    .assistant-msg, .assistant-msg.mine, .assistant-activity, .assistant-run-status { max-width:100%; width:auto; }
    .assistant-activity-meta { max-width:100%; }
    .assistant-composer, .assistant-channel-banner { margin-left:12px; margin-right:12px; }
  }
}

@media (prefers-reduced-motion:reduce) {
  .assistant-msg, .assistant-activity, .assistant-run-status { animation:none; }
  .assistant-stream-caret { animation:none; }
}

.assistant-thread-group-label { display:flex; align-items:center; gap:6px; margin:10px 4px 2px; padding:0 4px;
  font-size:0.6875rem; font-weight:600; letter-spacing:.02em; color:var(--text-secondary); }

.assistant-source-filters { display:flex; align-items:center; gap:2px; margin-left:10px; -webkit-app-region:no-drag; }
.assistant-source-btn { background:none; border:none; border-radius:6px; padding:4px; cursor:pointer;
  color:var(--text-secondary); display:inline-flex; align-items:center; justify-content:center; }
.assistant-source-btn:hover { background:var(--hover-bg); color:var(--text-color); }
.assistant-source-btn.active { background:var(--hover-bg); }
.assistant-source-btn.active.assistant-tg-btn { color:#2aabee; }
.assistant-source-btn.active.assistant-wa-btn { color:#25d366; }
.assistant-source-btn.active:not(.assistant-tg-btn):not(.assistant-wa-btn) { color:var(--accent-color); }

.assistant-thread-rename { flex:1; min-width:0; background:var(--surface-color); color:var(--text-color);
  border:1px solid var(--accent-color); border-radius:6px; padding:1px 6px; font:inherit; font-size:0.8125rem;
  outline:none; box-sizing:border-box; }

/* No horizontal padding: the shared list-page chrome bleeds by exactly the
   10px settings-pane-body inset, and kit rows line up with every core pane. */
.assistant-settings { padding:4px 0; color:var(--text-color); }
/* Section headings sit on kit rows directly, without the .settings-section flex
   gap the core panes get — so they carry that 12px themselves and read at the
   same size and rhythm as Markdown Editor's "Display". Direct children only: a
   list page's header band keeps its own flush margin:0. */
.assistant-settings > .settings-label { font-size:var(--h3-font-size); margin:var(--space-3) 0; }
/* A list page's detail view leads with its subject, the way AI Providers does. */
.assistant-detail-identity { display:flex; align-items:center; gap:12px; padding:12px 0 4px; }
.assistant-detail-identity .settings-list-sub { display:flex; align-items:center; gap:6px; }
.assistant-empty { color:var(--text-secondary); font-size:0.8125rem; padding:10px 2px; }
.assistant-sub { font-size:0.75rem; color:var(--text-secondary); margin:0 0 10px; }
.assistant-set-control { flex:1; min-width:0; display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
.assistant-set-control > .assistant-input, .assistant-set-control > .assistant-textarea { flex:1 1 220px; width:auto; min-width:0; }
.assistant-set-status { font-size:0.75rem; color:var(--text-secondary); }
.assistant-set-status.ok { color:#2fab53; }
.assistant-set-err { color:#e5484d; }
.assistant-link { color:var(--accent-color); font-size:0.75rem; text-decoration:none; white-space:nowrap; }
.assistant-link:hover { text-decoration:underline; }
.assistant-link-muted { color:var(--text-secondary); }

/* A green/amber/red status light for a connection (list row + detail identity). */
.assistant-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
.assistant-dot.ok { background:#2fab53; box-shadow:0 0 0 3px rgba(47,171,83,.18); }
.assistant-dot.off { background:#e5484d; box-shadow:0 0 0 3px rgba(229,72,77,.16); }
.assistant-dot.warn { background:#f5a623; box-shadow:0 0 0 3px rgba(245,166,35,.18); }

.assistant-provider { border:1px solid var(--border-light); border-radius:10px; padding:12px 14px; margin-bottom:10px; background:var(--container-color); }
.assistant-provider-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
.assistant-provider-title { display:flex; align-items:center; gap:9px; min-width:0; }
.assistant-provider-name { font-weight:600; text-transform:capitalize; }
.assistant-badge { font-size:0.6875rem; padding:2px 8px; border-radius:999px; border:1px solid var(--border-medium); color:var(--text-secondary); }
.assistant-badge.ok { background:var(--accent-tint-bg); color:var(--accent-tint-text); border-color:transparent; }
.assistant-badge.off { background:var(--container-color-alt); }

/* Usage & cost */
.assistant-usage-budget { border:1px solid var(--border-light); border-radius:10px; padding:12px 14px; margin-bottom:12px;
  background:var(--container-color); display:flex; flex-direction:column; gap:8px; }
.assistant-usage-budget-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.assistant-usage-spent { font-weight:600; color:var(--text-color); }
.assistant-usage-left { color:var(--text-secondary); font-size:0.8125rem; }
.assistant-usage-windows { display:flex; gap:18px; font-size:0.75rem; color:var(--text-secondary); flex-wrap:wrap; }
.assistant-bar { position:relative; height:8px; border-radius:999px; background:var(--container-color-alt); overflow:hidden; }
.assistant-bar-fill { position:absolute; inset:0 auto 0 0; height:100%; border-radius:999px; background:var(--accent-color); }
.assistant-bar-fill.over { background:#d8584b; }
.assistant-usage-rows { display:flex; flex-direction:column; gap:10px; }
.assistant-usage-row { display:grid; grid-template-columns:96px 1fr auto; align-items:center; gap:10px; min-width:0; }
.assistant-usage-row-name { font-size:0.8125rem; color:var(--text-color); text-transform:capitalize; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-usage-row-bar { min-width:0; display:flex; flex-direction:column; gap:3px; }
.assistant-usage-row-meta { font-size:0.6875rem; color:var(--text-secondary); }
.assistant-usage-row-cost { font-variant-numeric:tabular-nums; font-weight:600; color:var(--text-color); white-space:nowrap; }
.assistant-usage-empty { color:var(--text-secondary); font-size:0.8125rem; padding:8px 0; }
.assistant-usage-models { margin-top:8px; }
.assistant-usage-models summary { cursor:pointer; font-size:0.75rem; color:var(--text-secondary); }
.assistant-usage-budget-edit { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; }
.assistant-usage-budget-edit label { display:flex; align-items:center; gap:6px; font-size:0.75rem; color:var(--text-secondary); text-transform:capitalize; }
.assistant-usage-num { width:84px; }

/* A vault-relative file path + Open button (file-based personalities). */
.assistant-path { font-family:var(--mono-font, ui-monospace, monospace); font-size:0.71875rem; color:var(--text-secondary);
  background:var(--container-color-alt); border:1px solid var(--border-light); border-radius:6px; padding:2px 7px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; min-width:0; }

/* Connection rows, their header band and the detail's back band all come from the
   shared settings-listpage* / settings-list* set — never forked here. */

/* Built-in default-command rows. */
.assistant-builtins { display:flex; flex-direction:column; gap:6px; margin:4px 0 10px; }
.assistant-builtin-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.assistant-builtin-desc { font-size:0.75rem; color:var(--text-secondary); flex:1; min-width:120px; }
.assistant-cmd-tag { font-family:var(--mono-font, ui-monospace, monospace); font-size:0.75rem; color:var(--text-color);
  background:var(--container-color-alt); border:1px solid var(--border-light); border-radius:6px; padding:1px 7px; flex:0 0 auto; }

/* Custom-command editor (used at overall / connection / chat scopes). */
.assistant-cmd-editor { display:flex; flex-direction:column; gap:10px; margin:2px 0 4px; }
.assistant-cmd-row { display:flex; flex-direction:column; gap:6px; border:1px solid var(--border-light); border-radius:10px;
  padding:9px 10px; background:var(--container-color-alt); }
.assistant-cmd-head { display:flex; align-items:center; gap:6px; min-width:0; }
.assistant-cmd-slash { color:var(--text-secondary); font-family:var(--mono-font, ui-monospace, monospace); flex:0 0 auto; }
.assistant-cmd-name { flex:0 0 120px; min-width:0; }
.assistant-cmd-desc { flex:1 1 auto; min-width:0; }
.assistant-cmd-actions { display:flex; align-items:center; gap:8px; }

/* Chat-row context menu (right-click: Rename / Pin / Clear / Delete). */
.assistant-menu { position:fixed; z-index:1000; min-width:180px; padding:4px;
  background:var(--surface-color); border:1px solid var(--border-light); border-radius:10px;
  box-shadow:0 4px 16px rgba(0,0,0,.12); }
.assistant-menu button { display:flex; align-items:center; gap:8px; width:100%; padding:5px 8px;
  background:none; border:none; border-radius:6px; color:var(--text-color); font:inherit; font-size:0.8125rem;
  cursor:pointer; text-align:left; }
.assistant-menu button:hover { background:var(--hover-bg); }
.assistant-menu button.danger { color:var(--tint-red-text, #b91c1c); }
.assistant-menu button svg { width:13px; height:13px; flex-shrink:0; color:var(--text-tertiary); }
.assistant-menu button.danger svg { color:inherit; }
.assistant-menu-sep { height:1px; margin:4px 6px; background:var(--border-light); }

/* Small pin glyph shown inline in pinned chat rows. */
.assistant-thread-pin { display:inline-flex; width:11px; height:11px; flex:0 0 auto;
  color:var(--text-tertiary); margin-right:2px; }
`

export function injectStyles(): () => void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = CSS + providersCss + usageCss + chartsCss + loadingCss
  return () => {
    if (document.getElementById(STYLE_ID) === el) el.remove()
  }
}
