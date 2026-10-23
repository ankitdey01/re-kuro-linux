/* Shared Kuro desktop communications. Generated into both native bundles.
 * Source policy stays on the server; this module only validates, composes,
 * renders existing notice chrome, and reports qualifying presentation.
 */
(function (scope) {
    'use strict';
    const PLACEMENTS = ['account', 'earnings', 'referrals'];
    const VIEWS = [...PLACEMENTS, 'permissions'];
    const SEVERITIES = ['critical', 'warn', 'info'];
    const ICONS = {
        clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
        alert: '<path d="M12 3 2.5 20h19L12 3z"></path><path d="M12 10v4"></path><path d="M12 17.5h.01"></path>',
        info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>',
        gift: '<rect x="4" y="8" width="16" height="4"></rect><path d="M6 12v8h12v-8"></path><path d="M12 8v12"></path><path d="M12 8c-4 0-5-4-2.5-4S12 8 12 8zm0 0c4 0 5-4 2.5-4S12 8 12 8z"></path>',
        'trending-down': '<path d="M3 7l7 7 4-4 7 7"></path><path d="M21 12v5h-5"></path>',
        wallet: '<rect x="3" y="6" width="18" height="13" rx="1"></rect><path d="M16 12h.01"></path><path d="M3 9h18"></path>',
    };
    const isText = (v, max, empty = false) => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0);
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const key = n => JSON.stringify([n.kind, n.id, n.revision]);
    const presentationKey = n => n ? JSON.stringify([n.id, n.revision, n.title, n.paragraphs]) : null;
    const renderKey = n => { const { delivered, contentRevision, ...copy } = n; return copy; };
    function legacyRevision(value) {
        // Local display identity only, never an authorization/enforcement key.
        // Persist a compact digest rather than legacy private message content.
        const text = JSON.stringify(value); let a = 2166136261, b = 2246822507;
        for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 3266489909); }
        return 'legacy-' + (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16);
    }

    function safeAction(value) {
        if (typeof value !== 'string') return null;
        if (VIEWS.some(v => value === 'view:' + v)) return value;
        try {
            const url = new URL(value);
            if (url.protocol === 'https:' && !url.username && !url.password &&
                !url.port && ['trykuro.app', 'www.trykuro.app'].includes(url.hostname) &&
                /^\/(?:help|support)(?:\/|$)/.test(url.pathname)) return url.href;
        } catch (_) { /* Unknown actions never become executable navigation. */ }
        return null;
    }

    function service(value) {
        if (!value || !isText(value.id, 160) || !isText(value.title, 240) ||
            !isText(value.subline, 2000, true) || !PLACEMENTS.includes(value.placement)) return null;
        const notice = {
            kind: 'service', id: value.id,
            revision: isText(value.revision, 160) ? value.revision : null,
            title: value.title, paragraphs: [value.subline], placement: value.placement,
            severity: SEVERITIES.includes(value.severity) ? value.severity : 'info',
            icon: own(ICONS, value.icon) ? value.icon : 'info',
            pinned: value.pinned === true, highlight: value.highlight === true, cta: null,
        };
        const action = safeAction(value.cta?.action);
        if (action && isText(value.cta.label, 80)) notice.cta = { action, label: value.cta.label };
        // Legacy servers have no revision. Content itself is the stable identity;
        // never use account-global native dismissed IDs to hide revised copy.
        if (!notice.revision) notice.revision = legacyRevision([notice.title, notice.paragraphs, notice.cta, notice.pinned, notice.severity, notice.highlight]);
        return notice;
    }

    function guard(value, legacy = false) {
        if (value === null) return null;
        if (!value || !isText(value.id, 160) || !isText(value.title, 240) ||
            !isText(value.reason, 2000) || !isText(value.correction, 2000) ||
            (!legacy && (!isText(value.revision, 160) || !isText(value.email_hint, 500)))) return undefined;
        if (value.email_hint != null && !isText(value.email_hint, 500)) return undefined;
        if (value.revision != null && !isText(value.revision, 160)) return undefined;
        if (value.effective_delivery_at != null && !isText(value.effective_delivery_at, 80)) return undefined;
        return {
            kind: 'guard', id: value.id, revision: value.revision || legacyRevision([value.title, value.reason, value.correction, value.email_hint]),
            contentRevision: value.revision || null, title: value.title,
            paragraphs: [value.reason, value.correction, value.email_hint].filter(v => typeof v === 'string'),
            severity: 'warn', icon: 'info', pinned: true, highlight: false, cta: null,
            delivered: Boolean(value.effective_delivery_at),
        };
    }

    function envelope(value) {
        // Bound the actual bridge payload in UTF-8, including additive host
        // session metadata. Normalization never expands unbounded input.
        try {
            const encoded = JSON.stringify(value);
            if (!encoded || encoded.length > 32768 || new TextEncoder().encode(encoded).byteLength > 32768) return null;
        } catch (_) { return null; }
        if (!value || value.schema_version !== 1 || !isText(value.revision, 160) ||
            (value.next_transition_at != null && !isText(value.next_transition_at, 80)) ||
            typeof value.signups_enabled !== 'boolean' || !Array.isArray(value.notices) ||
            value.notices.length > 32 || !own(value, 'guard_notice')) return null;
        const notices = value.notices.map(service);
        const warning = guard(value.guard_notice);
        if (notices.includes(null) || warning === undefined) return null;
        return { revision: value.revision, signupsEnabled: value.signups_enabled, notices, warning };
    }

    // Shared by all three existing placements. A receipt is not a click or a
    // JSON download: the complete required copy must survive two paints, be
    // foreground, and fit the viewport AND every scrolling/clipping ancestor.
    function createPresentation(doc, send, visible, targets, now = () => doc.defaultView.performance.now()) {
        let warning = null, generation = 0, inFlight = false, received = false, scheduled = false;
        let failures = 0, retryAt = null;
        function fullyVisible(root) {
            if (!root?.isConnected || root.hidden || root.closest('[hidden]')) return false;
            const win = doc.defaultView;
            const box = root.getBoundingClientRect();
            if (!box.width || !box.height || box.top < -0.5 || box.left < -0.5 ||
                box.bottom > win.innerHeight + 0.5 || box.right > win.innerWidth + 0.5) return false;
            for (let node = root; node && node.nodeType === 1; node = node.parentElement) {
                const style = win.getComputedStyle(node);
                if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
                if (node !== root && /(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX)) {
                    const clip = node.getBoundingClientRect();
                    if (box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5 || box.left < clip.left - 0.5 || box.right > clip.right + 0.5) return false;
                }
            }
            // Geometry alone is insufficient when an existing payout dialog
            // or another in-app overlay covers otherwise visible copy.
            if (typeof doc.elementFromPoint === 'function') {
                const inset = 2;
                const points = [[box.left + inset, box.top + inset], [box.right - inset, box.top + inset],
                    [box.left + inset, box.bottom - inset], [box.right - inset, box.bottom - inset],
                    [(box.left + box.right) / 2, (box.top + box.bottom) / 2]];
                if (points.some(([x, y]) => !root.contains(doc.elementFromPoint(x, y)))) return false;
            }
            // A container can fit while an unbroken title or clipped text
            // escapes it. Verify every rendered line of required copy too.
            for (const copy of root.querySelectorAll('[data-guard-copy]')) {
                const style = win.getComputedStyle(copy);
                if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
                const range = doc.createRange(); range.selectNodeContents(copy);
                const lines = Array.from(range.getClientRects()).filter(r => r.width && r.height);
                if (!lines.length || lines.some(line => line.top < box.top - 0.5 || line.bottom > box.bottom + 0.5 ||
                    line.left < box.left - 0.5 || line.right > box.right + 0.5)) return false;
                if (typeof doc.elementFromPoint === 'function' && lines.some(line => {
                    const y = (line.top + line.bottom) / 2;
                    return [line.left + Math.min(1, line.width / 2), (line.left + line.right) / 2,
                        line.right - Math.min(1, line.width / 2)].some(x => !root.contains(doc.elementFromPoint(x, y)));
                })) return false;
            }
            return true;
        }
        async function present() {
            if (!warning || received || inFlight || !visible() || !doc.hasFocus() ||
                !targets().some(fullyVisible)) return;
            const token = generation;
            const params = { notice_id: warning.id };
            if (warning.contentRevision) params.content_revision = warning.contentRevision;
            inFlight = true;
            try {
                const response = await send('present_guard_notice', params);
                if (token === generation) received = response?.ok === true && response.result?.accepted === true;
            } catch (_) { /* Same-session retry on existing UI/sync events. */ }
            finally {
                if (token === generation) {
                    inFlight = false;
                    if (received) { failures = 0; retryAt = null; }
                    else {
                        failures++;
                        retryAt = now() + Math.min(60000, 5000 * 2 ** Math.min(failures - 1, 4));
                    }
                }
            }
        }
        function check() {
            if (!warning || received || scheduled || inFlight || (retryAt !== null && now() < retryAt)) return;
            scheduled = true;
            const token = generation;
            doc.defaultView.requestAnimationFrame(() => doc.defaultView.requestAnimationFrame(() => {
                scheduled = false;
                if (token === generation) present();
                else check();
            }));
        }
        // Existing native snapshots drive failed-delivery recovery. Normal
        // snapshots do no geometry work and no timer is introduced.
        function retry() { if (retryAt !== null && now() >= retryAt) check(); }
        function update(value) {
            if (presentationKey(value) !== presentationKey(warning)) {
                generation++; received = false; inFlight = false; failures = 0; retryAt = null;
            }
            warning = value;
            received = received || Boolean(value?.delivered);
            if (received) { failures = 0; retryAt = null; }
            check();
        }
        doc.defaultView.addEventListener('focus', check);
        doc.defaultView.addEventListener('resize', check);
        doc.addEventListener('visibilitychange', check);
        doc.addEventListener('scroll', check, true);
        return { update, check, retry, fullyVisible };
    }

    function create(options) {
        const { doc, send, visible, currentView, navigate, external } = options;
        const slots = Array.from(doc.querySelectorAll('.bulletin-slot'));
        let account = null, authority = false, notices = [], warning = null, signupsEnabled = null;
        let states = Object.create(null), seen = new Set();
        const fingerprints = new Map();
        const presentation = createPresentation(doc, send, visible, () =>
            Array.from(doc.querySelectorAll('[data-guard-presentation]')));
        const storageKey = () => 'kuro.communications.view.v1:' + encodeURIComponent(account || '');
        function persist() {
            if (!account) return;
            try { doc.defaultView.localStorage.setItem(storageKey(), JSON.stringify(states)); } catch (_) { /* Native storage may be unavailable. */ }
        }
        function state(n) {
            const k = key(n);
            if (!states[k]) {
                if (Object.keys(states).length >= 100) delete states[Object.keys(states)[0]];
                states[k] = {};
            }
            return states[k];
        }
        function setAccount(value, reset = false) {
            if (account === value && !reset) return;
            account = value; authority = false; notices = []; warning = null; signupsEnabled = null;
            states = Object.create(null); seen = new Set(); fingerprints.clear(); presentation.update(null);
            if (account) {
                try {
                    const raw = doc.defaultView.localStorage.getItem(storageKey());
                    const saved = raw && raw.length < 131072 ? JSON.parse(raw) : null;
                    if (saved && typeof saved === 'object' && !Array.isArray(saved))
                        for (const [k, v] of Object.entries(saved).slice(-100)) if (v && typeof v === 'object') states[k] = v;
                } catch (_) { /* Empty state is a safe fallback; no private text is persisted. */ }
            }
            slots.forEach(slot => slot.replaceChildren());
            render();
        }
        function apply(value) {
            if (!account) return false;
            const next = envelope(value);
            if (!next) return false;
            authority = true; notices = next.notices; warning = next.warning; signupsEnabled = next.signupsEnabled;
            render(); return true;
        }
        function legacy(bundle) {
            if (!account || authority || !bundle) return;
            if (Array.isArray(bundle.notices)) notices = bundle.notices.slice(0, 32).map(service).filter(Boolean);
            if (own(bundle, 'guard_notice')) {
                const next = guard(bundle.guard_notice, true);
                if (next !== undefined) warning = next;
            }
            if (typeof bundle.signups_enabled === 'boolean') signupsEnabled = bundle.signups_enabled;
            render();
        }
        // Only an owner/session-validated explicit unsupported signal reaches
        // this adapter. Keep the current display until a legacy read succeeds.
        function useLegacy() { authority = false; }
        function icon(className, name) {
            const span = doc.createElement('span'); span.className = className; span.setAttribute('aria-hidden', 'true');
            span.innerHTML = '<svg viewBox="0 0 24 24">' + (ICONS[name] || ICONS.info) + '</svg>';
            return span;
        }
        function cta(n) {
            if (!n.cta) return null;
            const button = doc.createElement('button'); button.type = 'button'; button.className = 'nb-cta';
            button.textContent = n.cta.label + ' ';
            button.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>');
            button.addEventListener('click', () => n.cta.action.startsWith('view:') ? navigate(n.cta.action.slice(5)) : external(n.cta.action));
            return button;
        }
        function paragraphs(root, n) {
            for (const text of n.paragraphs) {
                const p = doc.createElement('p'); p.textContent = text;
                if (n.kind === 'guard') p.dataset.guardCopy = '';
                root.appendChild(p);
            }
        }
        function card(n) {
            const card = doc.createElement('div');
            card.className = 'nb-item sev-' + n.severity + (n.highlight ? ' is-highlight' : '');
            card.dataset.messageId = n.id; card.dataset.messageKind = n.kind;
            card.appendChild(icon('nb-icon', n.icon));
            const copy = doc.createElement('div'); copy.className = 'nb-copy';
            const title = doc.createElement('strong'); title.textContent = n.title;
            if (n.kind === 'guard') title.dataset.guardCopy = '';
            copy.appendChild(title);
            paragraphs(copy, n); card.appendChild(copy);
            if (n.kind === 'guard') { card.dataset.guardPresentation = ''; card.setAttribute('role', 'status'); card.setAttribute('aria-live', 'polite'); }
            const action = cta(n); if (action) card.appendChild(action);
            if (!n.pinned) {
                const x = doc.createElement('button'); x.type = 'button'; x.className = 'nb-x'; x.setAttribute('aria-label', 'Dismiss notice');
                x.addEventListener('click', () => { state(n).dismissed = true; persist(); render(); }); card.appendChild(x);
            }
            return card;
        }
        function group(list, placement) {
            const root = doc.createElement('div'); root.className = 'nb-group tint-' + list[0].severity;
            let open = list.find(n => state(n)[placement] === true);
            // A new active warning expands once per view/revision. Routine sync
            // and view switches preserve the contributor's accordion choice.
            const fresh = list.find(n => n.kind === 'guard' && state(n)[placement] === undefined);
            if (fresh) { list.forEach(n => state(n)[placement] = n === fresh); open = fresh; persist(); }
            for (const n of list) {
                const expanded = n === open;
                const acc = doc.createElement('div'); acc.className = 'nb-acc' + (expanded ? ' open' : '');
                acc.dataset.messageId = n.id; acc.dataset.messageKind = n.kind;
                const row = doc.createElement('button'); row.type = 'button'; row.className = 'nb-row sev-' + n.severity;
                row.setAttribute('aria-expanded', String(expanded)); row.dataset.messageToggle = key(n);
                row.appendChild(icon('r-ic', n.icon));
                const title = doc.createElement('span'); title.className = 'r-title'; title.textContent = n.title;
                if (n.kind === 'guard') title.dataset.guardCopy = '';
                row.appendChild(title);
                row.insertAdjacentHTML('beforeend', '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>');
                row.addEventListener('click', () => { list.forEach(other => state(other)[placement] = other === n && !expanded); persist(); render(); });
                acc.appendChild(row);
                if (expanded) {
                    const detail = doc.createElement('div'); detail.className = 'nb-detail'; paragraphs(detail, n);
                    const action = cta(n); if (action) detail.appendChild(action); acc.appendChild(detail);
                    if (n.kind === 'guard') { acc.dataset.guardPresentation = ''; acc.setAttribute('role', 'status'); acc.setAttribute('aria-live', 'polite'); }
                }
                root.appendChild(acc);
            }
            return root;
        }
        function render() {
            const active = notices.filter(n => n.pinned || !state(n).dismissed)
                .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
            if (warning) active.unshift(warning);
            for (const slot of slots) {
                const placement = slot.dataset.placement;
                const unique = new Set();
                const list = active.filter(n => (n.kind === 'guard' && PLACEMENTS.includes(placement) || n.placement === placement) &&
                    !unique.has(key(n)) && unique.add(key(n)));
                if (placement === currentView() && visible()) list.forEach(n => seen.add(key(n) + ':' + placement));
                const signature = JSON.stringify(list.map(n => [renderKey(n), state(n)[placement]]));
                if (fingerprints.get(slot) === signature) continue;
                const view = slot.closest('.view'); const scrollTop = view?.scrollTop;
                const focused = slot.contains(doc.activeElement) ? doc.activeElement.dataset.messageToggle : null;
                const pinned = list.filter(n => n.pinned), dismissible = list.filter(n => !n.pinned);
                const children = [];
                if (pinned.length === 1) children.push(card(pinned[0]));
                else if (pinned.length > 1) children.push(group(pinned, placement));
                children.push(...dismissible.map(card)); slot.replaceChildren(...children);
                fingerprints.set(slot, JSON.stringify(list.map(n => [renderKey(n), state(n)[placement]])));
                if (focused) Array.from(slot.querySelectorAll('[data-message-toggle]')).find(n => n.dataset.messageToggle === focused)?.focus({ preventScroll: true });
                if (view && scrollTop != null) view.scrollTop = scrollTop;
            }
            for (const tab of doc.querySelectorAll('.side-tab[data-view]')) {
                const v = tab.dataset.view;
                tab.classList.toggle('has-note', v === 'account' && v !== currentView() && active.some(n =>
                    (n.kind === 'guard' || n.placement === 'account') && !seen.has(key(n) + ':account')));
            }
            presentation.update(warning);
        }
        return { setAccount, apply, legacy, useLegacy, render, check: presentation.check, retry: presentation.retry,
            signupsEnabled: () => signupsEnabled, hasWarning: () => Boolean(warning) };
    }
    scope.KuroCommunications = Object.freeze({ create, createPresentation, envelope, guard, service, safeAction });
})(globalThis);
