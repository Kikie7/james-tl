/* ═══════════════════════════════════════════════════════════════════════════
   James - TL  v4.0  —  Floating AI Sales Coach
   - IA logo avatar + speech bubble (proactive coaching)
   - Tactical + motivational + emotional support
   - Ask James (quick buttons + typed questions)
   - Post-call debrief with solidity judgment
   - Per-agent learning loop (Vercel)
   - Break/pause aware via Readymode mode dropdown
   ═══════════════════════════════════════════════════════════════════════════ */

(() => {
  const IS_TOP_FRAME = (window === window.top);

  // ── WHERE TO RENDER ─────────────────────────────────────────────────────────
  // ReadyMode sometimes wraps the whole agent UI in a (cross-origin) iframe — so
  // this code, pasted into the Contact-history script, runs INSIDE that frame,
  // not the literal top window. If we only rendered in window===window.top, James
  // would silently do nothing in the wrapped view (which is what happened after
  // ReadyMode moved to the wrapper layout). So: render in the top frame OR in any
  // frame large enough to be the main agent view, and skip only small widget
  // iframes (which would otherwise draw a stray avatar / capture duplicate audio).
  const IS_MAIN_FRAME = IS_TOP_FRAME ||
    (window.innerWidth >= 700 && window.innerHeight >= 450);
  if (!IS_MAIN_FRAME) {
    return;
  }
  // Boot exactly once per frame — the Contact-history script re-runs on each lead.
  if (window.__jamesTLLoaded) {
    return;
  }
  window.__jamesTLLoaded = true;

  // ══════════════════════════════════════════════════════════════════════════
  // TOP FRAME — full James
  // ══════════════════════════════════════════════════════════════════════════

  const CONFIG = {
    CAPTURE_START_MS:  3000,    // start listening shortly after a call connects
    COACH_START_MS:    8000,    // give the call a moment before first possible tip
    COACH_INTERVAL_MS: 8000,    // James READS every 8s; only SPEAKS when needed
    CHUNK_MS:          8000,    // 8s audio chunks → good accuracy + ~8-10s lag
    BUBBLE_LIFETIME_MS: 24000,  // proactive tips stay 24s (was too fast before)
    ASK_LIFETIME_MS:   38000,   // ask answers stay longer — you asked, read it
    IDLE_END_MS:       45000,   // no captions for this long = call ended
    DISPO_WAIT_MS:     35000,   // after a call, wait this long for the agent to pick a call result
  };

  // ── Groq is proxied through a STATELESS Railway service, NOT Vercel. Vercel is
  //    fronted by a Cloudflare WAF that intermittently 1010s the Groq calls
  //    (confirmed: identical requests sometimes reach the server, sometimes 1010 —
  //    a bot/browser-signature score). Railway (*.up.railway.app) isn't Cloudflare-
  //    fronted, so the AI path stops being blocked. Only the two AI endpoints move;
  //    all stateful routes (profiles/heartbeat/dashboard) stay on Vercel below.
  //    The secret rides base64-encoded — body field `k` for chat (injected by
  //    groqChat), X-James-Key header for audio; the proxy decodes it.
  const JAMES_KEY       = 'iaremo-james-9fK3nQ7wL2mP6vXc4bRj8sHy5dTz';
  const RAILWAY_PROXY   = 'https://vlm-report-production.up.railway.app';
  const PROXY_BASE      = 'https://vlm-report.vercel.app/api/profiles';
  const GROQ_ENDPOINT   = RAILWAY_PROXY + '/chat';
  const GROQ_TRANSCRIBE = RAILWAY_PROXY + '/audio';
  const GROQ_MODEL      = 'openai/gpt-oss-120b';
  const WHISPER_MODEL   = 'whisper-large-v3-turbo';
  const PROFILES_BASE = 'https://vlm-report.vercel.app/api/profiles';
  // Live dashboard pivot — real-time agent stats (source of truth)
  const PIVOT_BASE  = 'https://taylor-convenience-likelihood-populations.trycloudflare.com/pivot';
  const PIVOT_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImFnZW50X25hbWUiOm51bGwsImZ1bGxfbmFtZSI6IkFkbWluIiwic2NvcGUiOiJwZXJtYW5lbnQifQ.Vbr0FEFUWwmAX6LgL_POoCpyeHQHHWhq_RC89m3k330';

  // Headers for proxy calls. The secret rides in the URL (k param), so headers
  // stay minimal. For chat we send text/plain (JSON string body) to avoid a CORS
  // preflight — the server reads the body with json.loads regardless of type.
  // For audio we MUST send multipart (FormData sets its own Content-Type/boundary).
  function jamesHeaders(withJson) {
    const h = {};
    if (withJson) h['Content-Type'] = 'text/plain';
    return h;
  }

  // ── Chat helper for the Groq proxy ──────────────────────────────────────────
  // One place that owns the WAF-aware failure handling. Cloudflare's WAF 1010
  // block comes back as an HTTP 403 with a NON-JSON body ("error code: 1010"),
  // so calling r.json() on it throws and the real cause gets masked as a generic
  // "fetch:Unexpected token" parse error. Here we check r.ok FIRST and surface the
  // status + body snippet (flagged `waf1010`) into dbgErr, so the debug line shows
  // exactly what's blocking us. Returns parsed JSON on success, or null on an HTTP
  // error (dbgErr already set). Throws only on a transient network/timeout error
  // (after one retry) so each caller's own catch can show its fallback UI.
  async function groqChat(bodyObj, timeoutMs) {
    dbgReqs++;
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(GROQ_ENDPOINT, {
          method: 'POST',
          headers: jamesHeaders(true),
          // Secret rides in the body (field `k`), base64-encoded. Cloudflare's
          // WAF matches the literal secret string anywhere in the request (URL,
          // body, or header) and returns 1010, so we never send it verbatim —
          // btoa() changes the bytes and the server base64-decodes it.
          body: JSON.stringify({ k: btoa(JAMES_KEY), ...bodyObj }),
          signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
        });
        if (!r.ok) {
          const snippet = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 60);
          const waf = /\b1010\b/.test(snippet) ? ' waf1010' : '';
          dbgErr = 'groq:' + r.status + waf + (snippet ? ' ' + snippet : '');
          return null;                       // deterministic HTTP error (incl. WAF) — don't retry
        }
        return await r.json();
      } catch (e) {
        lastErr = e;                          // network / timeout — transient, retry once
      }
    }
    dbgErr = 'fetch:' + (lastErr && lastErr.name === 'TimeoutError'
      ? 'timeout'
      : ((lastErr && lastErr.message) || 'err')).slice(0, 30);
    throw lastErr;
  }

  // ── WAF-1010 isolation probe (console tool) ─────────────────────────────────
  // Run  __jamesDiag()  in the ReadyMode devtools console on a live https page to
  // pin down what trips Cloudflare WAF 1010 on the Groq proxy. Uses the REAL
  // in-page constants (JAMES_KEY / PROXY_BASE / GROQ_MODEL) so nothing drifts from
  // what James actually sends. Reports status + body snippet for each request
  // shape. See DIAGNOSTICS.md for how to read the result matrix.
  async function jamesDiag() {
    const enc = encodeURIComponent(JAMES_KEY);
    const trivialBody  = JSON.stringify({ test: 1 });
    const messagesBody = JSON.stringify({ messages: [{ role: 'user', content: 'say hello' }] });
    const realBody     = JSON.stringify({ model: GROQ_MODEL, messages: [{ role: 'user', content: 'say hello' }], max_tokens: 50 });
    const cases = [
      ['A control  fake-secret + trivial-body ', PROXY_BASE + '?k=hello', trivialBody],
      ['B         real-secret + trivial-body  ', PROXY_BASE + '?k=' + enc, trivialBody],
      ['C         fake-secret + messages-body ', PROXY_BASE + '?k=hello', messagesBody],
      ['D         real-secret + messages-body ', PROXY_BASE + '?k=' + enc, messagesBody],
      ['E full    real-secret + real-body     ', PROXY_BASE + '?k=' + enc, realBody],
    ];
    console.log('%c[James] WAF diagnostic — ' + cases.length + ' probes…', 'color:#3b82c4;font-weight:bold');
    const out = [];
    for (const [label, url, body] of cases) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
        const t = (await r.text()).replace(/\s+/g, ' ').trim().slice(0, 100);
        const waf = /\b1010\b/.test(t);
        out.push({ case: label.trim(), status: r.status, waf1010: waf, body: t });
        console.log('%c[diag] ' + label + '→ ' + r.status + (waf ? ' ⛔WAF-1010' : '') + '  ' + t,
                    waf ? 'color:#c0392b' : 'color:#2e7d32');
      } catch (e) {
        out.push({ case: label.trim(), status: 'threw', waf1010: false, body: e.name + ': ' + (e.message || '') });
        console.log('%c[diag] ' + label + '→ threw ' + e.name + ': ' + (e.message || '').slice(0, 60), 'color:#c0392b');
      }
    }
    console.log('%c[James] done. Read: B=1010 → the SECRET in the URL is the trigger. C/D=1010 → the messages[] BODY is the trigger. Only E=1010 → it is the combination.', 'color:#3b82c4');
    console.table(out);
    return out;
  }
  window.__jamesDiag = jamesDiag;

  let state = {
    callStartTime:   null,
    callId:          null,
    captureActive:   false,
    coachingActive:  false,
    jamesEnabled:    true,
    onBreak:         false,
    remotePaused:    false, // paused from the dashboard (admin)
    armed:           false,
    callLive:        false, // a real WebRTC customer stream is up right now
    webrtcSeen:      false, // WebRTC customer capture has worked at least once
    captionBuffer:   [],
    fullTranscript:  [],
    coachInterval:   null,
    lastCaptionTime: null,
    recentTips:      [],
    bubbleTimer:     null,
    askBubbleTimer:  null,
    minimized:       false,
    askOpen:         false,
    speechRecognition: null,
    // agent profile
    agentName:       '',
    coachingContext: '',
    weakSpots:       [],
    pressure:        'average',
    weekSolid:       0, weekVlm: 0, qSolid: 0, qVlm: 0,
    profileLoaded:   false,
    // learning loop
    adviceLog:       [],   // {advice, moment} given this call
    lastDisposition: '',
    lastDispoAt:     0,     // when the agent last clicked a call-result button
    pendingCall:     null,  // {transcript, advice, callId} awaiting a disposition before debrief
    coachingMemory:  null,
    agentTurns:      0,
    customerTurns:   0,
    pivotStats:      null,  // today's live stats from dashboard pivot
    baseline:        null,  // rolling 21-day strengths/weaknesses
    micStream:       null,  // active microphone stream
    micRecorder:     null,  // active MediaRecorder for mic
    tabStream:       null,  // active tab-capture stream (customer)
    tabRecorder:     null,  // active MediaRecorder for tab
    tabAudioCtx:     null   // audio context to keep tab audible
  };

  // debug counters
  let dbgCaptions = 0, dbgReqs = 0, dbgTips = 0, dbgErr = '';
  // Declared here (above init()) so init()'s startHeartbeat() call doesn't hit a
  // temporal-dead-zone ReferenceError — startHeartbeat is hoisted, but this `let`
  // is not, and init() runs during module load.
  let _heartbeatStarted = false;

  // ── TESTING HOOK: window.postMessage force-start, bypasses everything ──────
  window.addEventListener('message', (e) => {
    if (e.data && e.data.__jamesForceStart) {
      state.testMode = true;       // test mode disables break auto-detection
      state.jamesEnabled = true;
      state.armed = true;
      state.onBreak = false;
      state.callStartTime = null;
      startCall(true);
      const el = document.getElementById('jt-debug');
      if (el) el.textContent = 'FORCE-START fired — ' + el.textContent;
    }
  });

  // ── localStorage-backed settings (in-page; no chrome.* APIs available) ──────
  const JStore = {
    get(key, dflt) {
      try { const v = localStorage.getItem('jamestl_' + key); return v === null ? dflt : JSON.parse(v); }
      catch (_) { return dflt; }
    },
    set(key, val) {
      try { localStorage.setItem('jamestl_' + key, JSON.stringify(val)); } catch (_) {}
    }
  };

  // ── INIT ────────────────────────────────────────────────────────────────────
  (function init() {
    hookCustomerAudioViaWebRTC();   // patch WebRTC ASAP so we catch the call's customer stream
    hookDispositionButtons();       // capture the call result the agent clicks after each call
    state.jamesEnabled = JStore.get('jamesEnabled', true) !== false;
    state.minimized    = JStore.get('jamesMinimized', false) === true;
    const savedName = JStore.get('agentName', '');
    if (savedName) { state.agentName = savedName; loadAgentProfile(savedName); startHeartbeat(); }
    buildAvatar();
    observeCaptions();
    startAgentMic();
    detectReadymodeState();
    autoDetectAgentName();
    setInterval(updateDebug, 1000);
    // Debug line is hidden for agents. YOU can toggle it on/off while monitoring
    // with Ctrl+Shift+J (e.g. during the floor test).
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'J' || e.key === 'j')) {
        const dbg = document.getElementById('jt-debug');
        if (dbg) dbg.style.display = (dbg.style.display === 'none') ? 'block' : 'none';
      }
    });
    // Native bonus: keep trying to grab ReadyMode's call audio directly, so the
    // agent never has to click anything. Re-checks every few seconds; grabs as
    // soon as a live call audio element appears, and again after each new call.
    setInterval(() => {
      if (!state.jamesEnabled) return;
      if (!state.tabStream) tryCaptureReadymodeAudio();
    }, 4000);
    // Poll the dashboard pause switch so an admin can pause/resume this agent.
    setInterval(pollPauseState, 40 * 1000);
  })();

  // ── BUILD THE FLOATING AVATAR ────────────────────────────────────────────────
  function buildAvatar() {
    if (document.getElementById('james-tl-root')) return;
    // Inject our stylesheet (served from Deno) since there's no extension manifest
    // to load overlay.css for us.
    if (!document.getElementById('james-tl-style')) {
      const link = document.createElement('link');
      link.id = 'james-tl-style';
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/gh/Kikie7/james-tl@main/overlay.css';
      document.head.appendChild(link);
    }
    const root = document.createElement('div');
    root.id = 'james-tl-root';
    root.dataset.state = 'idle';
    if (state.minimized) root.classList.add('jt-minimized');

    root.innerHTML = `
      <div id="jt-ask-bubble" class="jt-type-tactical">
        <div id="jt-bubble-header">
          <span id="jt-ask-bubble-label" class="jt-tactical">James Says</span>
          <button id="jt-ask-bubble-close" title="Dismiss">×</button>
        </div>
        <div id="jt-ask-bubble-text"></div>
      </div>

      <div id="jt-bubble" class="jt-type-tactical">
        <div id="jt-bubble-header">
          <span id="jt-bubble-label" class="jt-tactical">Agent Tip</span>
          <button id="jt-bubble-close" title="Dismiss">×</button>
        </div>
        <div id="jt-bubble-text"></div>
      </div>

      <div id="jt-ask-panel">
        <div id="jt-ask-title">Ask James <button id="jt-ask-close">×</button></div>
        <div id="jt-quick-btns">
          <button class="jt-quick-btn" data-q="How do I handle this objection right now?">How do I handle this objection?</button>
          <button class="jt-quick-btn" data-q="Help me close and lock the appointment now.">Help me close this</button>
          <button class="jt-quick-btn" data-q="How do I build rapport with this customer?">How do I build rapport?</button>
          <button class="jt-quick-btn" data-q="What protocol items am I still missing on this call?">What am I missing?</button>
        </div>
        <div id="jt-ask-input-row">
          <input id="jt-ask-input" type="text" placeholder="Ask James anything..." />
          <button id="jt-ask-send">Ask</button>
        </div>
      </div>

      <div id="jt-controls">
        <button class="jt-ctrl-btn" id="jt-min-btn" title="Minimize / expand">MIN</button>
        <button class="jt-ctrl-btn" id="jt-toggle-btn" title="Turn James on/off">ON</button>
      </div>

      <div id="jt-head" title="Click to ask James">
        <img src="https://cdn.jsdelivr.net/gh/Kikie7/james-tl@main/icon128.png" alt="James" />
        <div id="jt-thinking"><span></span><span></span><span></span></div>
        <div id="jt-notif-dot"></div>
        <div id="jt-status-mini"></div>
      </div>

      <div id="jt-debug" style="display:none;"></div>
    `;
    document.body.appendChild(root);

    // Head click → toggle ask panel (or expand if minimized)
    document.getElementById('jt-head').addEventListener('click', (e) => {
      if (state._dragging) return;
      if (state.minimized) { toggleMinimize(); return; }
      toggleAskPanel();
    });

    // Double-click head → reset to default bottom-right corner (escape hatch if lost)
    document.getElementById('jt-head').addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.style.left = 'auto';
      root.style.top = 'auto';
      root.style.right = '20px';
      root.style.bottom = '20px';
      setAskOpen(false);
      showMiniStatus('Reset to corner');
    });

    document.getElementById('jt-bubble-close').addEventListener('click', hideBubble);
    document.getElementById('jt-ask-bubble-close').addEventListener('click', hideAskBubble);
    document.getElementById('jt-ask-close').addEventListener('click', () => setAskOpen(false));
    document.getElementById('jt-min-btn').addEventListener('click', toggleMinimize);
    document.getElementById('jt-toggle-btn').addEventListener('click', toggleEnabled);

    document.querySelectorAll('.jt-quick-btn').forEach(btn => {
      btn.addEventListener('click', () => askJames(btn.dataset.q));
    });
    document.getElementById('jt-ask-send').addEventListener('click', () => {
      const inp = document.getElementById('jt-ask-input');
      if (inp.value.trim()) { askJames(inp.value.trim()); inp.value = ''; }
    });
    document.getElementById('jt-ask-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = e.target.value.trim();
        if (v) { askJames(v); e.target.value = ''; }
      }
    });

    makeDraggable(document.getElementById('jt-head'), root);
    updateHeadState();
  }

  // ── DRAGGABLE ────────────────────────────────────────────────────────────────
  function makeDraggable(handle, root) {
    let sx, sy, sl, st;
    handle.addEventListener('mousedown', (e) => {
      state._dragging = false;
      sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect();
      sl = r.left; st = r.top;
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) state._dragging = true;
        const pos = clampPosition(sl + dx, st + dy);
        root.style.left = pos.left + 'px';
        root.style.top  = pos.top + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        setTimeout(() => { state._dragging = false; }, 50);
        snapIntoView(root);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // Compute a safe position for the avatar's top-left such that BOTH the head AND
  // any speech bubble (which appears ABOVE and to the LEFT of the head) stay fully
  // on screen. This is why a tip near an edge no longer pushes James out of frame.
  function clampPosition(left, top) {
    const headSize   = 70;
    // Reserve room for the bubble that pops above the head.
    const bubbleW    = 340;   // max bubble width + a little margin
    const bubbleH    = Math.min(window.innerHeight * 0.40, 320) + 30; // max bubble height + tail/gap
    const margin     = 8;
    // The root is right-aligned: its right edge sits near the head's right edge.
    // Horizontal: the bubble extends LEFT from the right edge, so the left edge of
    // the whole widget must stay >= margin. Keep the head's right edge within view.
    const minLeft = margin + (bubbleW - headSize); // leave bubble room on the left
    const maxLeft = window.innerWidth - headSize - margin;
    // Vertical: the bubble sits ABOVE the head, so the head's top must stay far
    // enough down that the bubble fits above it.
    const minTop = margin + bubbleH;              // leave bubble room above
    const maxTop = window.innerHeight - headSize - margin;
    return {
      left: Math.max(Math.min(minLeft, maxLeft), Math.min(left, maxLeft)),
      top:  Math.max(Math.min(minTop, maxTop),  Math.min(top, maxTop)),
    };
  }

  // Ensure the avatar AND its bubble are always fully visible on screen
  function snapIntoView(root) {
    const r = root.getBoundingClientRect();
    const pos = clampPosition(r.left, r.top);
    if (Math.abs(pos.left - r.left) > 1 || Math.abs(pos.top - r.top) > 1) {
      root.style.left = pos.left + 'px';
      root.style.top  = pos.top + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }
  }

  // Re-snap on window resize so it never gets stranded off-screen
  window.addEventListener('resize', () => {
    const root = document.getElementById('james-tl-root');
    if (root) snapIntoView(root);
  });

  // ── UI STATE HELPERS ─────────────────────────────────────────────────────────
  function root() { return document.getElementById('james-tl-root'); }

  function updateHeadState() {
    const r = root(); if (!r) return;
    let s = 'idle';
    if (state.remotePaused) s = 'break';
    else if (state.onBreak) s = 'break';
    else if (state.coachingActive) s = 'active';
    else if (state.captureActive) s = 'capturing';
    else if (state.callStartTime) s = 'waiting';
    r.dataset.state = (state.jamesEnabled && !state.remotePaused) ? s : 'idle';
    const tb = document.getElementById('jt-toggle-btn');
    if (tb) { tb.textContent = state.jamesEnabled ? 'ON' : 'OFF'; tb.dataset.off = state.jamesEnabled ? 'false' : 'true'; }
  }

  function showMiniStatus(text) {
    const el = document.getElementById('jt-status-mini');
    if (!el) return;
    el.textContent = text;
    el.classList.add('jt-show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('jt-show'), 4000);
  }

  function toggleMinimize() {
    state.minimized = !state.minimized;
    root().classList.toggle('jt-minimized', state.minimized);
    JStore.set('jamesMinimized', state.minimized);
    if (state.minimized) { setAskOpen(false); }
    else { document.getElementById('jt-notif-dot').classList.remove('jt-show'); }
  }

  function toggleEnabled() {
    state.jamesEnabled = !state.jamesEnabled;
    JStore.set('jamesEnabled', state.jamesEnabled);
    updateHeadState();
    if (state.jamesEnabled) {
      // Turning ON manually force-starts a coaching session (works for testing with recordings)
      state.armed = true;
      if (!state.callStartTime) startCall();
      showMiniStatus('Coaching started');
    } else {
      endCall(false);
      hideBubble();
      state.armed = false;
    }
  }

  function toggleAskPanel() { setAskOpen(!state.askOpen); }
  function setAskOpen(open) {
    state.askOpen = open;
    document.getElementById('jt-ask-panel').classList.toggle('jt-open', open);
  }

  // ── SPEECH BUBBLE ────────────────────────────────────────────────────────────
  // type: tactical | warn | urgent | morale | debrief
  const LABELS = {
    tactical: 'Agent Tip', warn: 'Watch This', urgent: 'Act Now',
    morale: 'From James', debrief: 'Call Debrief'
  };

  function showBubble(type, text, persist) {
    const bubble = document.getElementById('jt-bubble');
    const label  = document.getElementById('jt-bubble-label');
    const txt    = document.getElementById('jt-bubble-text');
    if (!bubble) return;

    if (state.minimized) {
      document.getElementById('jt-notif-dot').classList.add('jt-show');
      showMiniStatus(text.length > 40 ? text.slice(0,38) + '…' : text);
      return;
    }

    bubble.className = `jt-type-${type}`;
    label.className  = `jt-${type}`;
    label.textContent = LABELS[type] || 'Agent Tip';
    txt.textContent = text;

    requestAnimationFrame(() => requestAnimationFrame(() => bubble.classList.add('jt-visible')));

    clearTimeout(state.bubbleTimer);
    if (!persist) {
      state.bubbleTimer = setTimeout(hideBubble, CONFIG.BUBBLE_LIFETIME_MS);
    }
  }

  function hideBubble() {
    const bubble = document.getElementById('jt-bubble');
    if (bubble) bubble.classList.remove('jt-visible');
    clearTimeout(state.bubbleTimer);
  }

  // Separate bubble for ask-James answers — stacks above the tip bubble,
  // so a proactive tip and an answer to a question can show at the same time.
  function showAskBubble(type, text, persist) {
    const bubble = document.getElementById('jt-ask-bubble');
    const label  = document.getElementById('jt-ask-bubble-label');
    const txt    = document.getElementById('jt-ask-bubble-text');
    if (!bubble) return;

    if (state.minimized) {
      document.getElementById('jt-notif-dot').classList.add('jt-show');
      showMiniStatus(text.length > 40 ? text.slice(0,38) + '…' : text);
      return;
    }

    bubble.className = `jt-type-${type}`;
    label.className  = `jt-${type}`;
    label.textContent = 'James Says';
    txt.textContent = text;
    requestAnimationFrame(() => requestAnimationFrame(() => bubble.classList.add('jt-visible')));

    clearTimeout(state.askBubbleTimer);
    if (!persist) {
      // Answers to questions stay longer — the agent asked, give them time to read
      state.askBubbleTimer = setTimeout(hideAskBubble, CONFIG.ASK_LIFETIME_MS);
    }
  }

  function hideAskBubble() {
    const bubble = document.getElementById('jt-ask-bubble');
    if (bubble) bubble.classList.remove('jt-visible');
    clearTimeout(state.askBubbleTimer);
  }

  function setThinking(on) {
    const t = document.getElementById('jt-thinking');
    if (t) t.classList.toggle('jt-show', on);
  }

  // ── AGENT NAME AUTO-DETECT ─────────────────────────────────────────────────
  function autoDetectAgentName() {
    // ReadyMode exposes the logged-in agent two ways, both available at page load:
    //  1) the full name "Kikie Jacobs" sits in an <h2> and <span> elements (no id/class,
    //     so we match by content: a clean "First Last" inside a small element).
    //  2) a cookie `saved_account=Kikie.J` (login handle) — fallback if DOM not ready.
    const looksLikeName = (t) =>
      /^[A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2}$/.test(t) && t.length >= 4 && t.length < 40;

    const fromDom = () => {
      // Prefer headings/spans that hold just a name (the My-Files/user header etc.)
      const els = document.querySelectorAll('h2, span, .user, [class*="user"], [class*="agent"]');
      for (const el of els) {
        if (el.children.length !== 0) continue;          // leaf nodes only
        const t = (el.textContent || '').trim();
        if (looksLikeName(t)) return t;
      }
      return '';
    };

    const fromCookie = () => {
      // saved_account=Kikie.J  → "Kikie J"
      const m = document.cookie.match(/saved_account=([^;]+)/);
      if (!m) return '';
      let v = decodeURIComponent(m[1]).trim();             // "Kikie.J"
      v = v.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();  // "Kikie J"
      // Title-case each part
      v = v.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
      return looksLikeName(v) || /^[A-Z][a-z]+ [A-Z]$/.test(v) ? v : '';
    };

    const apply = (n) => {
      if (!n) return false;
      if (n !== state.agentName) {
        state.agentName = n;
        JStore.set('agentName', n);
        showMiniStatus(`${n} detected`);
        setTimeout(() => loadAgentProfile(n), 800);
      }
      // Always (re)start the heartbeat once we know who this is — even when the
      // name was already cached from a prior session (n === state.agentName).
      // Without this, returning agents never ping and the dashboard shows them
      // offline forever. startHeartbeat() is idempotent (guards _heartbeatStarted).
      startHeartbeat();   // tell the dashboard this agent has James running
      return true;
    };

    const tryD = () => {
      const dom = fromDom();
      if (dom) return apply(dom);
      const ck = fromCookie();
      if (ck) return apply(ck);
      return false;
    };

    if (tryD()) return;
    // DOM may not be fully rendered yet — retry for a bit
    let a = 0;
    const p = setInterval(() => { if (tryD() || ++a > 20) clearInterval(p); }, 1500);
  }

  // ── HEARTBEAT: tell the dashboard this agent has James running ───────────────
  // Fires once when the name is detected, then every 15 min while the page is open.
  // The dashboard uses last-seen to show who's online. Best-effort; never blocks.
  function startHeartbeat() {
    if (_heartbeatStarted || !state.agentName) return;
    _heartbeatStarted = true;
    sendHeartbeat();                          // immediately
    pollPauseState();                         // learn pause state right away
    setInterval(sendHeartbeat, 15 * 60 * 1000); // every 15 minutes
    // Also send one when the tab is being closed (best-effort, marks last activity)
    window.addEventListener('beforeunload', () => {
      try {
        const blob = new Blob(
          [JSON.stringify({ name: state.agentName, event: 'unload', timestamp: new Date().toISOString() })],
          { type: 'application/json' }
        );
        navigator.sendBeacon(`${PROFILES_BASE}?do=heartbeat`, blob);
      } catch (_) {}
    });
  }

  async function sendHeartbeat() {
    if (!state.agentName) return;
    try {
      await fetch(`${PROFILES_BASE}?do=heartbeat`, {
        method: 'POST',
        // text/plain keeps this a CORS "simple request" → no OPTIONS preflight.
        // The body is still JSON text; the server reads it with json.loads regardless.
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          name: state.agentName,
          event: 'alive',
          onCall: !!state.callStartTime,
          coaching: !!state.coachingActive,
          timestamp: new Date().toISOString()
        }),
        signal: AbortSignal.timeout(6000)
      }).then(r => r.ok ? r.json() : null)
        .then(d => { if (d && typeof d.paused === 'boolean') applyRemotePause(d.paused); })
        .catch(() => {});
    } catch (_) { /* non-fatal — dashboard just shows slightly stale last-seen */ }
  }

  // ── REMOTE PAUSE (dashboard) ────────────────────────────────────────────────
  // The dashboard can pause James for one agent or everyone. James polls this
  // every ~40s (and learns it on each heartbeat too). When paused it stops
  // listening, transcribing and coaching — but keeps heart-beating so the
  // dashboard still shows it online-but-paused, and so it hears "resume".
  function pollPauseState() {
    if (!state.agentName) return;
    fetch(`${PROFILES_BASE}?do=pause-state&name=${encodeURIComponent(state.agentName)}&t=${Date.now()}`,
          { signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && typeof d.paused === 'boolean') applyRemotePause(d.paused); })
      .catch(() => {});
  }

  function applyRemotePause(paused) {
    if (paused === state.remotePaused) return;
    state.remotePaused = paused;
    if (paused) {
      // Tear down anything in flight — no debrief (call is being cut short by admin).
      if (state.callStartTime) endCall(false);
      stopCustomerCapture();
      if (state.coachInterval) { clearInterval(state.coachInterval); state.coachInterval = null; }
      state.coachingActive = false;
      hideBubble();
      updateHeadState();
      showMiniStatus('Paused by admin');
      console.log('[James] paused by dashboard');
    } else {
      updateHeadState();
      showMiniStatus('Resumed');
      console.log('[James] resumed by dashboard');
    }
  }

  // ── LOAD AGENT PROFILE (direct fetch) ──────────────────────────────────────
  async function loadAgentProfile(name) {
    if (!name || name.length < 2) return;
    let res = null;
    try {
      const r = await fetch(`${PROFILES_BASE}?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
      res = await r.json();
    } catch (_) { res = { found: false }; }

    if (res?.found) {
      state.coachingContext = res.coaching_context || '';
      state.weakSpots = res.weak_spots || [];
      state.pressure  = res.pressure || 'average';
      state.weekSolid = res.week?.solid || 0; state.weekVlm = res.week?.vlm || 0;
      state.qSolid = res.quincena?.solid || 0; state.qVlm = res.quincena?.vlm || 0;
      state.coachingMemory = res.coaching_memory || null;
      state.profileLoaded = true;
      showMiniStatus(`${res.name}: ${state.weekSolid}S ${state.weekVlm}V wk`);
    } else {
      state.profileLoaded = false;
      showMiniStatus(`${name} — ready`);
    }

    // Also pull LIVE stats from the dashboard pivot (today's real numbers)
    loadPivotStats(name);
    // And the rolling 21-day baseline to establish strengths/weaknesses
    loadPivotBaseline(name);
  }

  // ── Fetch live agent stats from the dashboard pivot (TODAY) ────────────────
  async function loadPivotStats(name) {
    if (!name) return;
    const today = new Date().toISOString().slice(0, 10);
    const url = `${PIVOT_BASE}?start_date=${today}&end_date=${today}&is_active=all&token=${PIVOT_TOKEN}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const arr = await r.json();
      if (!Array.isArray(arr)) return;
      const row = matchAgentRow(arr, name);
      if (!row) return;

      const meetings  = row.meetings || 0;
      const solids    = row.solids || 0;
      const showups   = row.showups || 0;
      const calls     = row.calls || 0;
      const answered  = row.answered_calls || 0;
      const effective = row.effective_calls || 0;
      const solidRate = meetings ? Math.round(solids / meetings * 100) : 0;

      state.pivotStats = {
        calls, answered, effective, meetings, solids, showups, solidRate,
        summary: `TODAY'S LIVE STATS for ${name}: ${calls} dials, ${answered} answered, ${meetings} meetings set, ${solids} SOLID (${solidRate}% of meetings solid), ${showups} showups, ${effective} effective calls.`
      };
      showMiniStatus(`${name.split(' ')[0]}: ${meetings}mtg ${solids}solid today`);
    } catch (_) {}
  }

  // ── Fetch rolling 21-day baseline to establish strengths/weaknesses ────────
  async function loadPivotBaseline(name) {
    if (!name) return;
    const end = new Date();
    const start = new Date(); start.setDate(start.getDate() - 21);
    const s = start.toISOString().slice(0,10), e = end.toISOString().slice(0,10);
    const url = `${PIVOT_BASE}?start_date=${s}&end_date=${e}&is_active=all&token=${PIVOT_TOKEN}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const arr = await r.json();
      if (!Array.isArray(arr)) return;

      // The pivot may return one row per day per agent — sum them for this agent
      const key = name.trim().toLowerCase();
      const rows = arr.filter(a => {
        const an = (a.agent_name||'').trim().toLowerCase();
        return an === key || (an.includes(key.split(' ')[0]) && an.includes(key.split(' ').slice(-1)[0]));
      });
      if (!rows.length) return;

      const sum = (f) => rows.reduce((t,x)=>t+(x[f]||0),0);
      const calls = sum('calls'), answered = sum('answered_calls'), meetings = sum('meetings'),
            solids = sum('solids'), showups = sum('showups'), effective = sum('effective_calls'),
            sales = sum('sales');
      const days = new Set(rows.map(x=>x.call_date)).size || 1;

      const solidRate   = meetings ? Math.round(solids/meetings*100) : 0;
      const setRate     = answered ? Math.round(meetings/answered*100) : 0;   // meetings per answered call
      const showupRate  = meetings ? Math.round(showups/meetings*100) : 0;
      const avgMeetings = Math.round(meetings/days*10)/10;

      // Build a strength/weakness read from the baseline
      const strengths = [], weaknesses = [];
      if (setRate >= 8) strengths.push('strong at setting meetings from answered calls'); else if (setRate <= 3) weaknesses.push('low meeting-set rate — struggles to convert answered calls into meetings');
      if (solidRate >= 60) strengths.push('high solid rate — meetings they set tend to be solid'); else if (solidRate <= 35 && meetings >= 5) weaknesses.push('low solid rate — meetings often not solid (likely one-leggers or weak qualifying)');
      if (showupRate >= 50) strengths.push('good showup rate'); else if (showupRate <= 20 && meetings >= 5) weaknesses.push('low showup rate — appointments not sticking');

      state.baseline = {
        days, avgMeetings, solidRate, setRate, showupRate,
        summary: `${name}'s ${days}-day BASELINE: ~${avgMeetings} meetings/day, ${setRate}% set rate (meetings per answered call), ${solidRate}% solid rate, ${showupRate}% showup rate over ${meetings} meetings. ` +
          (strengths.length ? `STRENGTHS: ${strengths.join('; ')}. ` : '') +
          (weaknesses.length ? `WEAKNESSES: ${weaknesses.join('; ')}.` : '')
      };
    } catch (_) {}
  }

  function matchAgentRow(arr, name) {
    const key = name.trim().toLowerCase();
    return arr.find(a => (a.agent_name||'').trim().toLowerCase() === key)
        || arr.find(a => {
             const an = (a.agent_name||'').trim().toLowerCase();
             return an.includes(key.split(' ')[0]) && an.includes(key.split(' ').slice(-1)[0]);
           });
  }

  // ── READYMODE STATE: break detection + call detection ──────────────────────
  function detectReadymodeState() {
    setInterval(() => {
      if (state.testMode) return;   // test mode: don't let auto-detection interfere

      // 1) Break / mode detection — read the mode dropdown
      const mode = readReadymodeMode();
      const wasBreak = state.onBreak;
      state.onBreak = (mode === 'break');
      if (state.onBreak && !wasBreak) {
        endCall(false);
        hideBubble();
        setAskOpen(false);
        updateHeadState();
        showMiniStatus('On break — paused');
      } else if (!state.onBreak && wasBreak) {
        updateHeadState();
        showMiniStatus('Back — listening');
      }
      if (state.onBreak) return;

      // 2) Call active detection
      const active = isCallActive();
      if (active && !state.armed) {
        state.armed = true;
        startCall();
      } else if (!active && state.armed && state.callStartTime) {
        state.armed = false;
        const dispo = readDisposition();
        setTimeout(() => endCall(true, dispo), 1500);
      }
    }, 3000);

    // Idle fallback — no captions for a long time = call ended
    setInterval(() => {
      if (state.testMode) return;
      if (!state.callStartTime || !state.lastCaptionTime) return;
      if (Date.now() - state.lastCaptionTime > CONFIG.IDLE_END_MS) {
        endCall(true, readDisposition());
      }
    }, 5000);
  }

  function readReadymodeMode() {
    // The mode dropdown shows: Prep work, Ready, Break, Meeting, Last call, Inbound only
    // Readymode has MANY dropdowns — only trust one whose option set matches the mode list.
    const modeWords = ['prep work','ready','break','meeting','last call','inbound only'];
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      const opts = Array.from(sel.options || []).map(o => (o.text||'').toLowerCase().trim());
      const matchCount = opts.filter(o => modeWords.includes(o)).length;
      if (matchCount >= 3) {  // this is the real mode dropdown
        const val = (sel.value || sel.options?.[sel.selectedIndex]?.text || '').toLowerCase().trim();
        return val === 'break' ? 'break' : (val || null);
      }
    }
    return null;  // mode dropdown not found — assume NOT on break
  }

  function isCallActive() {
    // Primary: Readymode "Phone Status:" text
    const bt = document.body.innerText || '';
    const m = bt.match(/Phone Status:\s*([^\n]+)/i);
    if (m) {
      const s = m[1].toLowerCase();
      if (/on call|connected|in progress|talking|live|in-call|oncall/.test(s)) return true;
      if (/ready|denied|disconnect|idle|waiting|hangup|hung up|no phone/.test(s)) return false;
    }
    // Secondary: visible call-active elements
    for (const sel of ['[class*="on-call"]','[class*="oncall"]','[class*="call-active"]','[class*="in-call"]','[class*="active-call"]']) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return true;
    }
    return false;
  }

  // ReadyMode's "Step 1. Select a call result" panel — the exact buttons an
  // agent clicks to disposition a call. We hook the click instead of scraping,
  // because the result is chosen a few seconds AFTER the audio ends (and the
  // markup has no reliable "selected" class to read).
  const DISPO_LABELS = [
    'NA to Confirmation', 'Voicemail', 'Meeting Set', 'Meeting Confirmed',
    'Solid Callback/Follow Up', 'Cold Callback/Follow Up', 'No Answer', 'Hang Up',
    'Business', 'Renter', 'Out of Area', 'Wrong Address', 'Not Our Type of Client',
    'Wrong Number', 'Not interested', 'Do Not Call', 'Meeting Rescheduled'
  ];
  const _norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const DISPO_SET = new Set(DISPO_LABELS.map(_norm));

  // Results that are NOT a real pitch opportunity — no contact (voicemail, no
  // answer, hang up) or a disqualified lead (business, renter, wrong number...).
  // James doesn't debrief these and they don't count toward the agent's solid
  // rate — a voicemail isn't "not solid". (Genuine conversations that just
  // didn't convert — Not interested, callbacks, reschedules — still count.)
  const NO_PITCH_DISPOS = new Set([
    'NA to Confirmation', 'Voicemail', 'No Answer', 'Hang Up', 'Business',
    'Renter', 'Out of Area', 'Wrong Address', 'Not Our Type of Client',
    'Wrong Number', 'Do Not Call'
  ].map(_norm));
  const isNoPitch = (dispo) => NO_PITCH_DISPOS.has(_norm(dispo));

  // Watch for the agent clicking a call-result button anywhere on the page.
  function hookDispositionButtons() {
    if (window.__jamesDispoHooked) return;
    window.__jamesDispoHooked = true;
    document.addEventListener('click', (e) => {
      try {
        // Walk up a few levels — the label text may be on a child of the button.
        let el = e.target, hit = '';
        for (let i = 0; i < 3 && el; i++, el = el.parentElement) {
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt && txt.length <= 40 && DISPO_SET.has(_norm(txt))) { hit = txt; break; }
        }
        if (!hit) return;
        state.lastDisposition = hit;
        state.lastDispoAt = Date.now();
        console.log('%c[James] call result:', 'color:#e0a800;font-weight:bold', hit);
        // If a call just ended and we were holding the debrief for the result, run it now.
        if (state.pendingCall) finalizePendingDebrief(hit);
      } catch (_) {}
    }, true);
  }

  // The disposition captured for THIS call (only if clicked recently — otherwise
  // it's a stale result from a previous lead).
  function freshDisposition() {
    if (state.lastDisposition && (Date.now() - state.lastDispoAt) < 5 * 60 * 1000) {
      return state.lastDisposition;
    }
    return '';
  }

  function readDisposition() {
    // Prefer the actual button the agent clicked; fall back to the Solidty field.
    const d = freshDisposition();
    if (d) return d;
    const bt = document.body.innerText || '';
    const sol = bt.match(/Solid[iy]?ty:\s*([^\n]+)/i);   // ReadyMode labels it "Solidty"
    if (sol) return 'Solidity: ' + sol[1].trim();
    return '';
  }

  // Run the held-back debrief once the disposition is known (or we gave up waiting).
  function finalizePendingDebrief(dispo) {
    if (state._dispoTimer) { clearTimeout(state._dispoTimer); state._dispoTimer = null; }
    const pc = state.pendingCall;
    if (!pc) return;
    state.pendingCall = null;
    // No-pitch results (voicemail, wrong number, business...) aren't a real
    // opportunity — don't debrief and don't log them, so they never count as
    // "not solid" against the agent.
    if (isNoPitch(dispo)) {
      showMiniStatus('No pitch (' + dispo + ') — onto the next');
      return;
    }
    if (pc.transcript.length > 50 && state.jamesEnabled) {
      state.callId = pc.callId;   // log under the right call
      runDebrief(pc.transcript, pc.advice, dispo || '');
    }
  }

  // (Frame relay listener removed — agent mic via Whisper is the only audio source now.)

  // ── CALL LIFECYCLE ────────────────────────────────────────────────────────────
  function startCall(immediate) {
    if (!state.jamesEnabled || state.onBreak || state.remotePaused) return;
    state.callStartTime  = Date.now();
    state.callId         = 'call_' + Date.now();
    state.captionBuffer  = [];
    state.fullTranscript = [];
    state.recentTips     = [];
    state.adviceLog      = [];
    state.agentTurns     = 0;
    state.customerTurns  = 0;
    state.lastCaptionTime = Date.now();
    state.captureActive  = true;   // capture from the first word
    if (!state.micStream) startAgentMic();      // agent voice (mic permission, no picker)
    // CUSTOMER audio: native version taps ReadyMode's own call audio directly —
    // no screen-share, no button. Try now and the periodic retry will catch it
    // if the audio element isn't ready this instant.
    if (!state.tabStream) tryCaptureReadymodeAudio();

    if (immediate) {
      // Force-start (testing): coach right away
      state.coachingActive = true;
      updateHeadState();
      startCoachingLoop();
      return;
    }

    // Capture is on; coaching activates in onSpeech once a real 2-way exchange is detected
    state.coachingActive = false;
    updateHeadState();
    showMiniStatus('Listening...');
  }

  function endCall(doDebrief, disposition) {
    if (!state.callStartTime) return;
    const transcript = state.fullTranscript.join('\n');
    const advice = [...state.recentTips];
    const callId = state.callId;
    state.callStartTime = null;
    state.captureActive = false;
    state.coachingActive = false;
    if (state.coachInterval) { clearInterval(state.coachInterval); state.coachInterval = null; }
    updateHeadState();

    // No debrief wanted (paused / on break / mid-call cut) — drop anything pending.
    if (!doDebrief) {
      if (state._dispoTimer) { clearTimeout(state._dispoTimer); state._dispoTimer = null; }
      state.pendingCall = null;
      return;
    }
    if (transcript.length <= 50 || !state.jamesEnabled) return;

    // Hold the debrief until we know the call result. If the agent already
    // clicked one (Step 1 panel) — or a caller passed it — debrief immediately;
    // otherwise wait up to DISPO_WAIT_MS for the click, then debrief anyway so a
    // call never goes un-debriefed just because it wasn't dispositioned yet.
    state.pendingCall = { transcript, advice, callId };
    const known = disposition || freshDisposition();
    if (known) { finalizePendingDebrief(known); return; }
    if (state._dispoTimer) clearTimeout(state._dispoTimer);
    state._dispoTimer = setTimeout(() => finalizePendingDebrief(freshDisposition() || ''), CONFIG.DISPO_WAIT_MS);
  }

  // ── CAPTION / SPEECH HANDLING ──────────────────────────────────────────────
  // ── AUDIO CAPTURE via Groq Whisper ──────────────────────────────────────────
  // Captures the agent's mic in ~12s chunks, sends each to Groq Whisper, feeds text in.
  // (Chrome Live Caption can't be read by page scripts, so we transcribe audio ourselves.)

  // observeCaptions is now a no-op — we no longer scrape the DOM for captions.
  // Kept as a stub so existing init() calls don't break.
  function observeCaptions() { /* replaced by Whisper audio capture */ }

  function isSpeech(t) {
    if (t.length < 4 || t.length > 500) return false;
    if (/^\d+$/.test(t)) return false;
    if (/^[^a-zA-Z]+$/.test(t)) return false;
    return true;
  }

  // Start capturing the agent's microphone and transcribing via Whisper
  async function startAgentMic() {
    if (state.micStream) return; // already running
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
      });
      state.micStream = stream;
      beginChunkedCapture(stream, 'Agent');
      showMiniStatus('Mic on — transcribing');
    } catch (err) {
      // Permission denied or no mic — James still loads, just can't hear
      dbgErr = 'mic:' + (err.name || 'denied');
      console.warn('[James] mic capture failed:', err);
    }
  }

  function stopAgentMic() {
    try {
      if (state.micRecorder && state.micRecorder.state !== 'inactive') state.micRecorder.stop();
      if (state.micStream) state.micStream.getTracks().forEach(t => t.stop());
    } catch (_) {}
    state.micStream = null;
    state.micRecorder = null;
  }

  // ── CUSTOMER SIDE (native): tap ReadyMode's own call audio directly ──────────
  // Running INSIDE ReadyMode's page, we can find the SIP phone's <audio> element
  // (xenphone attaches the remote stream there) and capture it WITHOUT any
  // screen-share picker. Falls back to getDisplayMedia only if no element is found.
  async function startCustomerCapture() {
    if (state.tabStream) return; // already running

    // Try direct SIP audio first — no picker, no click needed.
    const direct = tryCaptureReadymodeAudio();
    if (direct) return;

    // Fallback: screen-share picker (only if we couldn't find ReadyMode's audio)
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      stream.getVideoTracks().forEach(t => t.stop());
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        dbgErr = 'tab:no-audio';
        showBubble('warn', 'No tab audio shared — when sharing, tick "Share tab audio".', false);
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const audioStream = new MediaStream(audioTracks);
      state.tabStream = audioStream;
      audioTracks[0].addEventListener('ended', () => { stopCustomerCapture(); });
      beginChunkedCapture(audioStream, 'Customer');
      showMiniStatus('Customer audio ON ✓');
      const cbtn = document.getElementById('jt-customer-btn');
      if (cbtn) { cbtn.textContent = '✓ HEARING CUST'; cbtn.dataset.off = 'true'; }
    } catch (err) {
      dbgErr = 'tab:' + (err.name || 'denied');
    }
  }

  // ── CUSTOMER AUDIO via WebRTC hook (v2) ─────────────────────────────────────
  // ReadyMode's SIP phone (SIP.js 0.7.5) plays the customer over a WebRTC
  // PeerConnection with NO <audio> element (confirmed: zero audio/video elements
  // exist during a live call), so tryCaptureReadymodeAudio() has nothing to tap.
  //
  // Two things broke the v1 hook on this old SIP.js:
  //   1) It read pc.getReceivers() ONCE, synchronously after setRemoteDescription
  //      resolved. On SIP.js 0.7.5 the remote (customer) track is delivered a beat
  //      later via the legacy stream API, so getReceivers() was usually empty.
  //   2) It fed the raw remote track straight into MediaRecorder. Chrome records a
  //      raw *remote* WebRTC track as SILENCE (a long-standing quirk) unless the
  //      track is pumped through the Web Audio graph first.
  //
  // v2 fixes both: it wraps the RTCPeerConnection CONSTRUCTOR so it catches every
  // PC (even ones SIP.js built from a cached constructor reference), listens on
  // ALL delivery paths — the modern `track` event, the legacy `addstream` event,
  // and a getReceivers() poll — and routes whatever it finds through an
  // AudioContext → MediaStreamDestination before recording. Recording the dest
  // stream (not the raw track) is what makes Chrome actually capture the audio,
  // and it also means stopCustomerCapture() tears down OUR graph without ever
  // touching the live call track.
  function captureCustomerTracks(tracks) {
    try {
      if (!state.jamesEnabled || state.remotePaused || state.tabStream) return false;   // disabled/paused, or already capturing
      const audio = (tracks || []).filter(t => t && t.kind === 'audio' && t.readyState !== 'ended');
      if (!audio.length) return false;

      const raw = new MediaStream(audio);
      // Pump the remote track through Web Audio so Chrome will actually record it.
      let recStream = raw, ctx = null;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          ctx = new AC();
          if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
          const src  = ctx.createMediaStreamSource(raw);
          const dest = ctx.createMediaStreamDestination();
          src.connect(dest);
          if (dest.stream.getAudioTracks().length) recStream = dest.stream;
        }
      } catch (_) { recStream = raw; ctx = null; }

      state.tabStream   = recStream;
      state.tabAudioCtx = ctx;
      state.tabIsDirect = true;
      state.callLive    = true;   // authoritative "a call is really happening" signal
      state.webrtcSeen  = true;   // proves the hook works here — trust it from now on
      // Customer track ending IS the call ending — run the debrief, then clean up.
      audio[0].addEventListener('ended', () => {
        state.callLive = false;
        if (state.callStartTime && !state.testMode) {
          const d = readDisposition();
          setTimeout(() => endCall(true, d), 1200);
        }
        stopCustomerCapture();
      });

      // A live customer stream IS the call starting. Arm capture/coaching if the
      // DOM detector hasn't already (this is the reliable trigger; DOM scraping
      // was firing on non-calls, e.g. the agent watching a video).
      if (!state.callStartTime) { state.armed = true; startCall(); }

      beginChunkedCapture(recStream, 'Customer');
      showMiniStatus('Hearing customer (WebRTC) ✓');
      const cbtn = document.getElementById('jt-customer-btn');
      if (cbtn) { cbtn.textContent = '✓ HEARING CUST'; cbtn.dataset.off = 'true'; }
      console.log('[James] captured customer audio via WebRTC (v2)');
      return true;
    } catch (_) { return false; }
  }

  function jamesAttachToPc(pc) {
    try {
      if (!pc || pc.__jamesPcAttached) return;
      pc.__jamesPcAttached = true;

      // Modern: ontrack fires once per remote track.
      try {
        pc.addEventListener('track', (e) => {
          const tracks = (e.streams && e.streams[0] && e.streams[0].getAudioTracks)
            ? e.streams[0].getAudioTracks()
            : (e.track ? [e.track] : []);
          captureCustomerTracks(tracks);
        });
      } catch (_) {}

      // Legacy (SIP.js 0.7.5 path): onaddstream / 'addstream'.
      const onAdd = (e) => {
        try { if (e && e.stream && e.stream.getAudioTracks) captureCustomerTracks(e.stream.getAudioTracks()); } catch (_) {}
      };
      try { pc.addEventListener('addstream', onAdd); } catch (_) {}
      try { pc.onaddstream = onAdd; } catch (_) {}

      // Poll getReceivers()/getRemoteStreams() — covers the case where the track
      // was already attached before we hooked, or neither event fires.
      let tries = 0;
      const poll = setInterval(() => {
        tries++;
        if (state.tabStream || tries > 24) { clearInterval(poll); return; }
        try {
          let tracks = [];
          if (pc.getReceivers) tracks = pc.getReceivers().map(r => r && r.track).filter(Boolean);
          if (!tracks.length && pc.getRemoteStreams) {
            pc.getRemoteStreams().forEach(s => { try { tracks = tracks.concat(s.getAudioTracks()); } catch (_) {} });
          }
          if (captureCustomerTracks(tracks)) clearInterval(poll);
        } catch (_) {}
      }, 500);
    } catch (_) {}
  }

  function hookCustomerAudioViaWebRTC() {
    try {
      const RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
      if (!RTC || RTC.__jamesRTCHooked) return;

      // 1) Wrap the constructor so every NEW PeerConnection gets our listeners.
      const Wrapped = function (...args) {
        const pc = new RTC(...args);
        try { jamesAttachToPc(pc); } catch (_) {}
        return pc;
      };
      Wrapped.prototype = RTC.prototype;
      try { Object.defineProperty(Wrapped, 'name', { value: RTC.name }); } catch (_) {}
      window.RTCPeerConnection = Wrapped;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;

      // 2) Also patch setRemoteDescription on the prototype, so PeerConnections
      //    built from a constructor reference SIP.js cached BEFORE we wrapped it
      //    still get attached (the remote desc is always set on an incoming call).
      if (RTC.prototype && !RTC.prototype.__jamesSRDHooked) {
        const origSRD = RTC.prototype.setRemoteDescription;
        RTC.prototype.setRemoteDescription = function (...a) {
          try { jamesAttachToPc(this); } catch (_) {}
          return origSRD.apply(this, a);
        };
        RTC.prototype.__jamesSRDHooked = true;
      }

      RTC.__jamesRTCHooked = true;
      console.log('[James] WebRTC customer-audio hook installed (v2)');
    } catch (e) {
      console.warn('[James] WebRTC hook failed:', e);
    }
  }

  // Collect <audio>/<video> elements from the top frame AND every same-origin
  // child frame. James runs in the top frame, but ReadyMode's SIP call-audio
  // element often lives in a different (same-origin) frame, so a top-only query
  // misses the customer stream. Cross-origin frames are skipped (unreachable).
  function collectMediaEls() {
    const out = [];
    const add = (doc) => { try { out.push.apply(out, doc.querySelectorAll('audio, video')); } catch (_) {} };
    add(document);
    try { add(window.top.document); } catch (_) {}
    try {
      const fr = window.top.frames;
      for (let i = 0; i < fr.length; i++) { try { add(fr[i].document); } catch (_) {} }
    } catch (_) {}
    return out;
  }

  // Hunt for ReadyMode's call-audio <audio> element and capture its stream.
  // Returns true if it found and captured audio, false otherwise.
  function tryCaptureReadymodeAudio() {
    try {
      const audios = collectMediaEls();
      // Find an audio element that actually has a live MediaStream (the call)
      let target = null;
      for (const el of audios) {
        const s = el.srcObject;
        if (s && typeof s.getAudioTracks === 'function' && s.getAudioTracks().length) {
          // prefer one that's playing / has enabled tracks
          if (s.getAudioTracks().some(t => t.enabled && t.readyState === 'live')) {
            target = el; break;
          }
          if (!target) target = el;
        }
      }
      if (!target || !target.srcObject) return false;

      const callStream = target.srcObject;
      const audioStream = new MediaStream(callStream.getAudioTracks());
      state.tabStream = audioStream;
      state.tabIsDirect = true;

      // If the call ends and the track dies, clean up so the next call re-grabs.
      const t0 = audioStream.getAudioTracks()[0];
      if (t0) t0.addEventListener('ended', () => { stopCustomerCapture(); });

      beginChunkedCapture(audioStream, 'Customer');
      showMiniStatus('Hearing customer (direct) ✓');
      const cbtn = document.getElementById('jt-customer-btn');
      if (cbtn) { cbtn.textContent = '✓ HEARING CUST'; cbtn.dataset.off = 'true'; }
      console.log('[James] captured ReadyMode call audio directly — no screen-share');
      return true;
    } catch (err) {
      console.warn('[James] direct audio capture failed, will fall back:', err);
      return false;
    }
  }

  // ── (legacy screen-share path kept above as fallback) ──────────────────────
  async function _unusedScreenShareStub() {
    if (state.tabStream) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      // We only need audio — stop the video track immediately to save resources
      stream.getVideoTracks().forEach(t => t.stop());

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        dbgErr = 'tab:no-audio';
        showBubble('warn', 'No tab audio shared — when sharing, tick "Share tab audio".', false);
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      // Build an audio-only stream from the shared audio track
      const audioStream = new MediaStream(audioTracks);
      state.tabStream = audioStream;

      // If the agent stops sharing via Chrome's bar, clean up
      audioTracks[0].addEventListener('ended', () => { stopCustomerCapture(); });

      beginChunkedCapture(audioStream, 'Customer');
      showMiniStatus('Customer audio ON ✓');
      const cbtn = document.getElementById('jt-customer-btn');
      if (cbtn) { cbtn.textContent = '✓ HEARING CUST'; cbtn.dataset.off = 'true'; }
    } catch (err) {
      // User cancelled the picker, or not allowed
      dbgErr = 'tab:' + (err.name || 'fail');
      console.warn('[James] tab capture failed:', err);
    }
  }

  function stopCustomerCapture() {
    try {
      if (state.tabStream) state.tabStream.getTracks().forEach(t => t.stop());
      if (state.tabAudioCtx) state.tabAudioCtx.close();
    } catch (_) {}
    state.tabStream = null;
    state.tabAudioCtx = null;
    state.callLive = false;
    const cbtn = document.getElementById('jt-customer-btn');
    if (cbtn) { cbtn.textContent = '🔊 CUSTOMER'; cbtn.dataset.off = 'false'; }
  }

  // Records audio in repeating ~12s chunks; each chunk → Whisper → onSpeech
  function beginChunkedCapture(stream, speaker) {
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
               : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
               : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';

    // Is this stream still supposed to be running?
    const stillLive = () => speaker === 'Agent' ? !!state.micStream : !!state.tabStream;

    const startOne = () => {
      if (!stillLive()) return;
      let chunks = [];
      let rec;
      try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
      catch (_) { rec = new MediaRecorder(stream); }
      if (speaker === 'Agent') state.micRecorder = rec; else state.tabRecorder = rec;

      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: mime || 'audio/webm' });
        chunks = [];
        // Only transcribe when a call is genuinely in progress. Once the WebRTC
        // hook has proven it works here (webrtcSeen), trust callLive exclusively —
        // that stops James transcribing the agent's mic between calls (music,
        // side chatter). Before that, fall back to the DOM-based captureActive so
        // James still works if WebRTC capture never engages. Never while paused.
        const onCall = state.testMode || (state.webrtcSeen ? state.callLive : state.captureActive);
        if (blob.size > 2000 && onCall && !state.remotePaused) {
          transcribeChunk(blob, speaker);
        }
        if (stillLive()) startOne();  // continuous
      };

      rec.start();
      setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch(_){} }, CONFIG.CHUNK_MS);
    };

    startOne();
  }

  // Send one audio chunk to Whisper, feed the transcript to onSpeech
  async function transcribeChunk(blob, speaker) {
    try {
      const form = new FormData();
      form.append('file', blob, 'chunk.webm');
      form.append('model', WHISPER_MODEL);
      form.append('response_format', 'text');
      form.append('language', 'en');
      form.append('temperature', '0');  // most literal transcription, less hallucination
      // NOTE: deliberately NOT sending a 'prompt' — Whisper was echoing the prompt
      // text into the transcript as if it were spoken. No prompt = no leak.

      const r = await fetch(GROQ_TRANSCRIBE, {
        method: 'POST',
        // Audio is multipart (can't carry a JSON `k`), so the secret rides in the
        // X-James-Key header, base64-encoded (the WAF matches the literal secret
        // in headers too; server base64-decodes it). This makes it a non-simple
        // CORS request → the server's do_OPTIONS/_cors handle the preflight.
        headers: { 'X-James-Key': btoa(JAMES_KEY) },
        body: form,
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) { dbgErr = 'whisper:' + r.status; return; }
      let text = (await r.text()).trim();
      if (!text || text.length < 3) return;
      if (!isRealSpeech(text)) return;  // drop silence artifacts & hallucinations
      dbgErr = '';
      onSpeech(text, speaker);
    } catch (err) {
      dbgErr = 'whisper:' + (err.name === 'TimeoutError' ? 'timeout' : 'err');
    }
  }

  // Filters out Whisper's known junk: silence fillers, prompt echoes, and
  // the repetitive hallucinations it produces on unclear/overlapping audio.
  function isRealSpeech(text) {
    const t = text.toLowerCase().trim();
    // Silence/filler artifacts Whisper emits on quiet audio
    if (/^(you|thank you\.?|thanks for watching\.?|bye\.?|\.|\s|\u266a|\[.*\])+$/i.test(text)) return false;
    // Prompt-echo leaks (domain hint bleeding into output)
    if (/home improvement sales call|plenty of resources for your house/i.test(t)) return false;
    // Known repetitive hallucinations on this audio setup
    const hallucinations = [
      "i'm going to go to the office",
      "i'm going to go to the next slide",
      "i'm going to go ahead and get a little bit of a break",
      "i want to see you in the next video",
      "i'll see you next time",
      "i'm going to go to the morning"
    ];
    if (hallucinations.includes(t.replace(/[.,!?]+$/,''))) return false;
    // Pure repetition of a single word (e.g. "no no no no no")
    const words = t.split(/\s+/);
    if (words.length >= 4 && new Set(words).size === 1) return false;
    return true;
  }

  function onSpeech(text, speaker) {
    dbgCaptions++;
    state.lastCaptionTime = Date.now();
    if (state.onBreak || state.remotePaused) return;

    // A real call begins the moment we're armed and hear speech — capture starts immediately
    if (!state.callStartTime) { if (state.armed || state.testMode) startCall(); else return; }

    const tagged = `${speaker}: ${text}`;
    const last = state.fullTranscript[state.fullTranscript.length - 1];
    if (last === tagged) return;
    console.log('%c[James] heard:', 'color:#3b82c4', tagged);
    state.fullTranscript.push(tagged);
    state.captionBuffer.push(tagged);
    if (state.fullTranscript.length > 250) state.fullTranscript.shift();

    // Track exchanges to detect a REAL two-way conversation (not voicemail/dead air)
    if (speaker === 'Agent') state.agentTurns++;
    else state.customerTurns++;

    // Engage coaching once it's a genuine back-and-forth. Two ways to detect it:
    //  - a real customer channel gave us ≥2 customer turns (ideal), OR
    //  - the audio is mixed onto one channel (the customer bleeds into the agent
    //    mic, so everything is tagged "Agent") — then use a sustained exchange as
    //    the signal. Without this second path, calls where the SIP/customer stream
    //    isn't separately captured never get LIVE tips (only the post-call debrief).
    if (!state.coachingActive && !state.testMode) {
      const twoWay    = state.customerTurns >= 2 && state.agentTurns >= 2;
      const sustained = (state.agentTurns + state.customerTurns) >= 5;
      if (twoWay || sustained) {
        state.coachingActive = true;
        updateHeadState();
        startCoachingLoop();
        showMiniStatus('Live conversation — coaching');
      }
    }
  }

  // ── PROACTIVE COACHING LOOP ────────────────────────────────────────────────
  function startCoachingLoop() {
    if (state.coachInterval) clearInterval(state.coachInterval);
    state.coachInterval = setInterval(async () => {
      if (!state.coachingActive || !state.jamesEnabled || state.onBreak || state.remotePaused) return;
      const chunk = [...new Set(state.captionBuffer)].join(' ').trim();
      state.captionBuffer = [];
      if (chunk.length < 15) return;
      console.log('%c[James] CHUNK being sent:', 'color:#5ba829;font-weight:bold', chunk);
      console.log('%c[James] FULL transcript tail:', 'color:#888', state.fullTranscript.slice(-8).join(' | '));
      await getCoachingTip(chunk);
    }, CONFIG.COACH_INTERVAL_MS);
  }

  function buildProfileBlock() {
    const nameRef = state.agentName ? `Agent name: ${state.agentName}.` : '';
    const perf = state.profileLoaded && state.coachingContext ? state.coachingContext : '';
    const weak = state.weakSpots?.length ? `Known weak spots this week: ${state.weakSpots.slice(0,3).join(', ')}.` : '';
    const tone = !state.profileLoaded ? 'No history yet — coach fundamentals.'
      : state.pressure === 'struggling' ? `Struggling this week (${state.weekSolid}S/${state.weekVlm}V). Be direct but encouraging.`
      : state.pressure === 'performing' ? `Performing well (${state.weekSolid}S/${state.weekVlm}V). Reinforce, keep momentum.`
      : `Average (${state.weekSolid}S/${state.weekVlm}V). Push for consistency.`;
    let mem = '';
    if (state.coachingMemory?.recent_reflections?.length) {
      mem = `What you learned coaching this agent before (apply it): ${state.coachingMemory.recent_reflections.join(' ')}`;
    }
    // Live pivot stats — today's real numbers
    const live = state.pivotStats?.summary || '';
    // 21-day baseline — strengths/weaknesses and how today compares
    const base = state.baseline?.summary || '';
    let compare = '';
    if (state.pivotStats && state.baseline) {
      const t = state.pivotStats.solidRate, b = state.baseline.solidRate;
      if (b && t < b - 15) compare = `NOTE: today's solid rate (${t}%) is BELOW their ${b}% norm — something may be off today, coach accordingly.`;
      else if (b && t > b + 15) compare = `NOTE: today's solid rate (${t}%) is ABOVE their ${b}% norm — they're on fire, keep them going.`;
    }
    return `${nameRef}\n${perf}\n${weak}\n${tone}\n${mem}\n${base}\n${live}\n${compare}`;
  }

  const PROTOCOL_BLOCK = `
━━━ SOLID APPOINTMENT CHECKLIST ━━━
NON-NEGOTIABLE (no SOLID without these):
• ALL homeowners present — if two homeowners exist, BOTH must be there. Only one = "one-legger" = NOT solid (e.g. wife present but husband alive & well and absent).
• Detailed specific SERVICE — exactly which service (windows, solar, roofing, bathroom, kitchen, siding, curtains, etc.), scope, and the real need. Vague = not solid. Do NOT assume the service — it's whatever this lead is about.

HEAVILY WEIGHTED (strong solid signals):
• Appointment date & time locked • Address confirmed • Homeownership confirmed • 1-hour arrival window explained ("between 4-5, not exactly 4, due to traffic") • Dispatch confirmation (customer MUST answer the confirm call/text)

NICE TO HAVE (good practice, won't sink a solid):
• 2nd phone number • Email for promos • HOA membership • Open insurance claim • Credit score (680+ = offer discount)

SOLID = both homeowners present + detailed service + 80%+ of the rest covered.

━━━ THE WINNING PLAYBOOK (how our best closers book solids — coach toward THIS) ━━━
These are the exact moves that book appointments here. When you coach, push the agent toward these:
• FREE, NO OBLIGATION — say it early and often: "free quote, no obligation," "no charge, no commission." It melts cold-call resistance.
• CONFIRM ADDRESS FROM "THE SYSTEM" — a power move that confirms the address AND signals legitimacy: "My system shows you at [address] — is that correct?" or "I can pull it up, just verify it for me."
• HOMEOWNER CONFIRM VIA LEGITIMACY — tie it to being licensed/bonded: "Since we're licensed and bonded, I've got the homeowner info — so it'll be you AND [other homeowner] there, right?" Always lock BOTH homeowners.
• 1-HOUR ARRIVAL WINDOW — never an exact time: "I'll put you between 5:30 and 6:30" / "give me the hour window."
• "I'LL CALL BEFORE I SHOW UP" — every solid ends with this dispatch confirmation. Make sure the agent says it.
• ALWAYS ASK HOA + INSURANCE — "You're not under an HOA?" and "This is out of pocket, not an insurance claim, right?"
• ASSUMPTIVE CLOSE — never "do you want to book?" Instead: "I'll put you down for 5 o'clock."
• PRICE OBJECTION ("my buddy/someone does it cheaper") — don't fold: "Does your buddy have time for you? He's probably swamped." Then: "It's a FREE estimate — let me show you my best price, cash or financing." Pivot back to the free visit.
• "NOT RIGHT NOW" → FREEZE THE PRICE: "We freeze the price — call me when you're ready, even months out." Keeps the door open and still books a soft visit.
• MENTION FINANCING as a closer: "cash, financing, or half and half."`;

  const PERSONA_BLOCK = `
You are James, a sharp, supportive but FIRM sales TEAM LEADER coaching agents at a home-improvement call center that offers MULTIPLE services (windows, solar, roofing, bathrooms, kitchens, siding, curtains, and more). NEVER assume the service is windows — read the transcript and coach around whatever the agent is actually pitching. If the service isn't clear yet, coach the agent to pin it down.

IMPORTANT — agents do NOT name their company on these calls. They pitch as a local licensed contractor/handyman. Do NOT tell the agent to say a company name, and never reference "IA Remodeling" or any brand in your tips.

━━━ CRITICAL: HOW TO READ THE TRANSCRIPT ━━━
The transcript comes from imperfect live audio capture. The "Agent:" and "Customer:" labels are UNRELIABLE — they are often wrong or swapped, and lines may be garbled or duplicated. DO NOT trust the labels. Instead, read the WHOLE conversation as one flow and use common sense to follow what's happening:
- The person PITCHING, asking qualifying questions, and trying to book the appointment is the AGENT (the one you're coaching).
- The person being sold to, asking about price, giving their address, saying "let me talk to my family" is the CLIENT.
- A name like "this is Mason" belongs to the AGENT introducing themselves — never assume it's the client's name.
- If a line looks garbled or like a transcription error, ignore it and focus on the clear parts.
- When unsure who said something, just coach the agent on what to do next — say "the client" / "she" / "he" for the customer, and don't use the agent's name.

Read for the GIST of where the call is, not word-by-word. Your job is to coach the agent's next move based on the overall situation.

These are mostly COLD CALLS. Expect resistance, brush-offs, and people who didn't ask to be called. Your job: help the agent turn a cold lead into a SOLID booked appointment.

You coach the WHOLE call from the very first exchanges:
- OPENING: if the agent's open is weak/flat, coach it ("That open was flat — ask how their day's going, warm them up before pitching").
- BRUSH-OFF: the instant the customer resists ("not interested", "who is this", "how'd you get my number", "I'm busy", "take me off your list"), give the EXACT rebuttal line to keep them on ("I hear you — quick question first, what made you think about improving your home recently?").
- QUALIFYING & PROTOCOL: coach toward the solid checklist as it develops.
- CLOSE: push the assumptive close when they're warm.

STRATEGY-SHIFTING: You track what's working in THIS call. If the agent keeps doing something that isn't landing — repeating an ask, pushing a line the customer keeps dodging — call it out and change the play: "You've asked for credit score three times, they're dodging — drop it, build trust, circle back." Also connect to their HISTORY: if their profile shows a recurring pattern and it's happening again, name it: "Same over-pushing on price as usual — ease off, let them talk."

VOICE — supportive but firm. On their side AND straight with them:
- Encouraging: "Slow down, breathe, this one's yours."
- Firm when it's not working: "That's not landing. Stop. Here's what we do instead..."
- Honest after a rough one: "That client was rough — shake it off. Next one."
- Celebrate real wins: "That's how you do it — now lock the date."
Never wishy-washy, never demeaning. Direct, warm, in their corner.

SALES FRAMEWORK (Straight Line / Wolf of Wall Street): assume the sale, rapport first, flip every objection into a reason to meet, create urgency, assumptive close, never let silence kill momentum.`;

  async function getCoachingTip(recentText) {
    const fullContext = state.fullTranscript.join('\n').slice(-2800);
    const already = state.recentTips?.length
      ? `\nTIPS ALREADY GIVEN THIS CALL (do NOT repeat/rephrase — if the agent ignored one and it still matters, escalate to a STRATEGY SHIFT instead):\n${state.recentTips.slice(-6).map(t=>`- ${t}`).join('\n')}` : '';

    // Track call phase — by conversation turns, with transcript length as fallback
    // (recordings come through as one speaker, so turns alone won't advance — use length too)
    const turns = state.agentTurns + state.customerTurns;
    const lines = state.fullTranscript.length;
    const depth = Math.max(turns, lines);  // whichever shows more progress
    let phase, phaseGuide;
    if (depth <= 4) {
      phase = 'OPENING';
      phaseGuide = 'Call just started. The opening still matters — coach warmth/hook if weak.';
    } else if (depth <= 12) {
      phase = 'QUALIFYING';
      phaseGuide = 'Past the opening — DO NOT coach the opening anymore, that moment has passed. Coach qualifying: service specifics, homeowners, building the case, handling resistance.';
    } else {
      phase = 'CLOSING';
      phaseGuide = 'Deep into the call — the opening is LONG gone, never mention it. Focus on closing: lock date/time, confirm non-negotiables (all homeowners, service detail), arrival window, dispatch. Push the assumptive close.';
    }

    const prompt = `${PERSONA_BLOCK}

${buildProfileBlock()}
${PROTOCOL_BLOCK}

CURRENT CALL PHASE: ${phase}
${phaseGuide}

FULL CALL TRANSCRIPT SO FAR (mixed audio — both speakers, may be mislabeled):
"${fullContext}"

WHAT WAS JUST SAID (last few seconds):
"${recentText}"
${already}

━━━ HOW A REAL TEAM LEADER COACHES ━━━
You're whispering in the agent's ear mid-call. A great TL does NOT talk constantly — most of the time the agent is fine, let them work. Filler is WORSE than silence.

ONE THING AT A TIME. Never cram multiple checklist items into one tip. A real TL says "get the address now" — not "get the address and confirm both homeowners and explain the window and ask about HOA." Pick the SINGLE most important next move for this exact moment and coach just that. Crammed, listy advice is the #1 thing to avoid.

GROUND IT IN THIS CALL. Your tip must reference what's actually happening right now in the transcript. If you can't point to a specific thing that just happened, stay silent ({"speak": false}).

SOUND HUMAN, NOT LIKE A CHECKLIST. Coach the way our closers actually talk — smooth and natural. Compare:
❌ ROBOTIC: "To give you an accurate free estimate I need your address and to confirm both homeowners will be present."
✅ NATURAL: "He didn't give the address yet — say: 'Let me pull you up real quick, you're at...?'"
❌ ROBOTIC: "You should build rapport and handle the objection about price."
✅ NATURAL: "Price pushback. Don't flinch — 'It's totally free to look, no obligation. Worst case you get a number.'"

MATCH WHERE THE CALL IS:
- If the client is resisting/stalling → give the exact rebuttal line, nothing else.
- If a key step got skipped (address, both homeowners, the hour window, "I'll call before I come") → nudge that ONE step, in the closer's natural voice.
- If they're warm and it's time → push the assumptive close: "Lock it — 'I'll put you down for 5, I'll call before I head over.'"
- If they're doing great → stay silent or a 3-word boost.

THINK before you speak:
- What's the ONE most valuable thing right now?
- Did something specific just happen that needs a response?
- Or is the agent fine and I should stay quiet?

If nothing specific warrants it → {"speak": false}. Silence is right more often than not.

Respond ONLY as JSON, no markdown:
- Nothing to say: {"speak": false}
- Real reason: {"speak": true, "type":"tactical|warn|urgent|morale", "tip":"ONE move, max 22 words, in a closer's natural voice. Give the actual words to say. Never invent the customer's name. Never assume the service."}

When you speak, make it ONE sharp, natural, immediately-usable nudge — never a checklist.`;

    setThinking(true);
    try {
      const data = await groqChat({ model: GROQ_MODEL, messages: [{role:'user',content:prompt}], max_tokens: 1500, temperature: 0.45, reasoning_effort: 'low', include_reasoning: false }, 12000);
      setThinking(false);
      if (!data) return;  // HTTP/WAF error — dbgErr already set by groqChat
      if (data.error) { dbgErr = 'groq:' + (data.error.message||'').slice(0,40); return; }

      const msg = data?.choices?.[0]?.message || {};
      // GPT OSS may put text in content, or reasoning_content, or content may be an array
      let raw = '';
      if (typeof msg.content === 'string') raw = msg.content;
      else if (Array.isArray(msg.content)) raw = msg.content.map(c => c.text || c.content || '').join(' ');
      if (!raw && msg.reasoning_content) raw = msg.reasoning_content;
      raw = (raw || '').trim();

      if (!raw) { dbgErr = 'noraw:' + JSON.stringify(msg).slice(0,40); return; }

      // Try to extract JSON from anywhere in the response
      let parsed = null;
      const cleaned = raw.replace(/```json|```/g, '').trim();
      try { parsed = JSON.parse(cleaned); }
      catch(_) {
        // Find a JSON object inside the text
        const m = cleaned.match(/\{[\s\S]*?\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch(_) {} }
      }

      // James decided to stay silent — respect it
      if (parsed && parsed.speak === false) {
        dbgErr = 'silent'; dbgTips = dbgTips;  // no tip, intentional
        return;
      }

      let tip, type;
      if (parsed && parsed.tip) {
        tip = String(parsed.tip).trim();
        type = ['tactical','warn','urgent','morale'].includes(parsed.type) ? parsed.type : 'tactical';
      } else if (parsed && parsed.speak === undefined && !parsed.tip) {
        // Malformed but no clear tip — stay silent rather than show junk
        dbgErr = 'silent?';
        return;
      } else {
        // No JSON at all — treat whole response as tip only if it looks like advice
        const t = cleaned.replace(/^["']|["']$/g,'').replace(/^(tip|agent tip)[:\-\s]+/i,'').split('\n')[0].slice(0,180).trim();
        if (t.length > 5 && !/^\{/.test(t)) { tip = t; type = 'tactical'; }
        else { dbgErr = 'silent'; return; }
      }

      if (tip && tip.length > 2) {
        dbgTips++; dbgErr = '';
        state.recentTips.push(tip);
        if (state.recentTips.length > 10) state.recentTips.shift();
        state.adviceLog.push({ advice: tip, type });
        showBubble(type, tip, false);
      } else { dbgErr = 'silent'; }
    } catch (e) { setThinking(false); dbgErr = 'fetch:' + (e.message||'').slice(0,30); }
  }

  // ── ASK JAMES (agent-initiated) ─────────────────────────────────────────────
  async function askJames(question) {
    setAskOpen(false);
    setThinking(true);
    showAskBubble('tactical', 'Thinking…', true);
    const fullContext = state.fullTranscript.join('\n').slice(-2500);
    const hasCall = state.fullTranscript.length > 2;
    const lastBit = state.fullTranscript.slice(-6).join('\n');

    const prompt = `${PERSONA_BLOCK}

${buildProfileBlock()}
${PROTOCOL_BLOCK}

The agent is on a LIVE call RIGHT NOW and just asked you for help: "${question}"

FULL CALL TRANSCRIPT SO FAR (Agent + Customer):
"${fullContext || '(no transcript captured yet)'}"

MOST RECENT EXCHANGE (what's happening this moment):
"${lastBit || '(nothing yet)'}"

${hasCall
  ? 'ANSWER BASED ON THIS SPECIFIC CALL. When they ask "how do I handle this?" — "this" means the situation in the transcript above. Reference what the customer actually just said/did. Give the exact words or move for THIS moment. Do NOT give a generic opening script or textbook answer — they are mid-call, read where they are and respond to it.'
  : 'The call has barely started or no transcript yet — give a brief practical answer to their question.'}

Max 40 words. Warm, confident, firm TL voice. Never invent the customer's name.
Respond ONLY as JSON: {"type":"tactical|urgent|morale","tip":"your answer grounded in this call"}`;

    try {
      const data = await groqChat({ model: GROQ_MODEL, messages:[{role:'user',content:prompt}], max_tokens: 1800, temperature: 0.5, reasoning_effort: 'low', include_reasoning: false }, 12000);
      setThinking(false);
      if (!data || data.error) { showAskBubble('warn', 'Hmm, try again in a moment.', false); return; }
      let raw = (data?.choices?.[0]?.message?.content || '').replace(/```json|```/g,'').trim();
      let parsed; try { parsed = JSON.parse(raw); } catch(_) {
        const m = raw.match(/\{[\s\S]*?\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch(_){} }
        if (!parsed) parsed = { type:'tactical', tip: raw.replace(/^["']|["']$/g,'').slice(0,220) };
      }
      const type = ['tactical','urgent','morale'].includes(parsed.type) ? parsed.type : 'tactical';
      showAskBubble(type, parsed.tip || 'Here to help — keep going.', false);
    } catch(_) { setThinking(false); showAskBubble('warn', 'Connection hiccup — try again.', false); }
  }

  // ── POST-CALL DEBRIEF + SOLIDITY JUDGMENT + LEARNING ──────────────────────
  async function runDebrief(transcript, advice, disposition) {
    setThinking(true);
    const adviceList = advice.length ? advice.map(a=>`- ${a}`).join('\n') : '(no tips were given)';
    const prompt = `${PERSONA_BLOCK}

${PROTOCOL_BLOCK}

A call just ENDED. Here is the full transcript:
"${transcript.slice(-2500)}"

${disposition ? `Readymode disposition/solidity field: "${disposition}"` : ''}
Coaching tips James gave during this call:
${adviceList}

DO THREE THINGS:
1. JUDGE SOLIDITY yourself from the transcript using the checklist. Decide: "solid" or "not_solid". Remember: both homeowners present is non-negotiable (one-legger = not solid), detailed service is non-negotiable. The disposition is a hint but YOUR protocol judgment decides.
2. Give the agent a short, warm DEBRIEF — what went well + the single most important thing to improve next call. Be specific and encouraging, like a TL who wants them to win. (e.g. "Your opening was a little flat — next call open with how their day's going. But your close was strong, you locked the date well.")
3. REFLECT on your own coaching: did your advice help? If the call wasn't solid, what should you coach differently for this agent next time?

Respond ONLY as JSON, no markdown:
{
 "solidity":"solid|not_solid",
 "reason":"one line why (e.g. only one homeowner present / both confirmed + service detailed)",
 "debrief":"2-3 warm sentences to the agent: what was good + #1 fix",
 "missing":["protocol items that were missed"],
 "self_reflection":"one line: what James should coach differently next time for this agent"
}`;

    try {
      const data = await groqChat({ model: GROQ_MODEL, messages:[{role:'user',content:prompt}], max_tokens: 2500, temperature: 0.4, reasoning_effort: 'medium', include_reasoning: false }, 18000);
      setThinking(false);
      if (!data || data.error) return;
      let raw = (data?.choices?.[0]?.message?.content||'').replace(/```json|```/g,'').trim();
      let d; try { d = JSON.parse(raw); } catch(_) { return; }

      // Show debrief in the bubble (persists so agent can read during wrap-up)
      const solidEmoji = d.solidity === 'solid' ? '✓ Solid' : '○ Not solid yet';
      const debriefText = `${solidEmoji} — ${d.reason || ''}\n\n${d.debrief || ''}`;
      showBubble('debrief', debriefText, true);

      // Write the learning back to Vercel (per-agent)
      logCallOutcome(d, transcript, advice, disposition);
    } catch(_) { setThinking(false); }
  }

  async function logCallOutcome(d, transcript, advice, disposition) {
    if (!state.agentName) return;
    try {
      await fetch(`${PROFILES_BASE}?do=coaching`, {
        method: 'POST',
        headers: { 'Content-Type':'text/plain' },  // simple request, no preflight
        body: JSON.stringify({
          name: state.agentName,
          callId: state.callId,
          solidity: d.solidity,
          reason: d.reason,
          missing: d.missing || [],
          advice_given: advice,
          disposition: disposition || '',   // the call result the agent picked in ReadyMode
          self_reflection: d.self_reflection || '',
          // Send the transcript + debrief so the dashboard can show how the call
          // actually went (server caps the sizes). Transcript trimmed to the tail.
          transcript: (transcript || '').slice(-8000),
          debrief: d.debrief || '',
          timestamp: new Date().toISOString()
        }),
        signal: AbortSignal.timeout(6000)
      });
    } catch(_) { /* non-fatal */ }
  }

  // ── DEBUG ─────────────────────────────────────────────────────────────────
  function updateDebug() {
    const el = document.getElementById('jt-debug');
    if (!el) return;
    if (state.minimized) return;
    const md = state.onBreak ? 'BREAK' : (state.coachingActive ? 'coach' : 'off');
    const en = state.jamesEnabled ? 'EN' : 'dis';
    const k = 'proxy';
    const tm = state.testMode ? 'TEST' : '';
    const mic = state.micStream ? 'mic✓' : 'mic✗';
    const tab = state.tabStream ? 'tab✓' : 'tab✗';
    const lines = state.fullTranscript.length;
    el.textContent = `${mic} ${tab} ${md} ${en} ${k} ${tm} lines:${lines} reqs:${dbgReqs} tips:${dbgTips}${dbgErr?' '+dbgErr:''}`;
  }

})();
