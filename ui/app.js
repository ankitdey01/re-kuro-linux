/* =========================================================================
   Kuro Windows - WebView2 host bindings
   State is rendered from CoreBridge snapshots. Commands are sent to the WPF
   host through window.chrome.webview.postMessage.
   ========================================================================= */

const hostBridge = window.chrome && window.chrome.webview;
const pendingHostRequests = new Map();
let nextHostRequestId = 1;

const $ = (selector, context = document) => context.querySelector(selector);
const $$ = (selector, context = document) => Array.from(context.querySelectorAll(selector));

const GOOGLE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
</svg>`;

const KURO_MARK_SVG = `<svg class="brand-mark" viewBox="0 0 100 100" aria-hidden="true">
    <rect x="0" y="0" width="100" height="100" rx="22" fill="#0a0a0a"/>
    <text x="50" y="50" font-family="Outfit, var(--font-display)" font-weight="700" font-size="60" fill="#f5f5f5" text-anchor="middle" dominant-baseline="central">K</text>
</svg>`;

const UPDATE_ICONS = {
    check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
    download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12"/><path d="M6 14l6 6 6-6"/></svg>`,
    warn: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
};

const CREST_PALETTE = [
    '#2563eb', '#9333ea', '#0891b2', '#16a34a',
    '#4f46e5', '#db2777', '#a16207',
];

const DESIGN_STATE_COVERAGE = Object.freeze([
    '01_welcome',
    '02_signing_in',
    '03_review_agree',
    '04_all_set',
    '05_restoring',
    '06_sign_in_error',
    'signup_paused',
    '08_device_suspended',
    '09_account_suspended',
    '10_device_linked',
    '11_update_required',
    '12_privacy_paused',
    '13_tray_menu_removed',
    'runtime_dashboard',
    'earnings_loading',
    'earnings_error',
    'referrals_loading',
    'referrals_error',
    'payout_dialog',
]);

let snapshot = null;
let currentView = 'account';
let initializedView = false;
let dashboardCommandError = null;
let pendingSignIn = false;
let showOnboardingComplete = false;
let signOutBusy = false;
let quitBusy = false;
let requestedWindowMode = null;
let windowResizePending = false;

const WINDOW_MODES = Object.freeze({
    solo: { width: 600, height: 400 },
    dashboard: { width: 800, height: 600 },
});

const hashView = location.hash.replace('#', '');
const requestedInitialView = ['account', 'earnings', 'referrals', 'permissions'].includes(hashView)
    ? hashView
    : 'account';

document.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('mousedown', (event) => {
    if (event.button === 2) event.preventDefault();
}, true);
document.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const interactive = event.target.closest('button, a, input, textarea, select, [role="button"]');
    if (interactive) return;
    const dragRegion = event.target.closest('[data-window-drag-region]');
    if (!dragRegion) return;
    sendCommand('begin_window_drag').catch(() => {});
}, true);
document.addEventListener('auxclick', (event) => {
    if (event.button === 1 || event.button === 2) event.preventDefault();
}, true);
document.addEventListener('keydown', (event) => {
    const reloadShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r';
    if (reloadShortcut || event.key === 'F5') {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
}, true);
// NOTE: the global wheel/touchmove preventDefault was removed — the Payouts and
// Referrals views scroll internally now. Context-menu, reload, and drag-region
// guards above stay.
document.addEventListener('wheel', (event) => {
    // Ctrl+wheel is zoom (trackpad pinch arrives this way too) — never allowed
    // in the fixed-DIP shell. Host-side IsPinchZoomEnabled=false is the
    // primary lock; this is defense-in-depth. Plain scrolling is untouched.
    if (event.ctrlKey) event.preventDefault();
}, { passive: false });

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
}

function errorMessage(error, fallback) {
    if (error && typeof error.message === 'string') return error.message;
    if (typeof error === 'string' && error) return error;
    return fallback;
}

function handleHostEvent(event) {
    if (event && event.type === 'communications_unsupported') {
        acceptCommunicationsUnsupported(event.communications, event.owner_user_id, event.session_generation);
        return;
    }
    if (event && event.type === 'communications_changed') {
        acceptCommunications(event.communications, event.owner_user_id, event.session_generation);
        return;
    }
    if (event && event.type === 'snapshot' && event.snapshot) {
        snapshot = event.snapshot;
        if (snapshot.auth && snapshot.auth.state !== 'SigningIn') {
            pendingSignIn = false;
        }
        render();
    }
}

function handleHostMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'event') {
        handleHostEvent(message.event);
        return;
    }

    if (message.type !== 'response') return;

    const pending = pendingHostRequests.get(message.id);
    if (!pending) return;
    pendingHostRequests.delete(message.id);
    if (message.ok) {
        pending.resolve(message.result);
    } else {
        const err = new Error(message.error && message.error.message
            ? message.error.message
            : 'The desktop service rejected this action.');
        if (message.error && message.error.code) err.code = message.error.code;
        pending.reject(err);
    }
}

if (hostBridge) {
    hostBridge.addEventListener('message', (event) => handleHostMessage(event.data));
}

function sendHostRequest(method, params) {
    if (!hostBridge) {
        return Promise.reject(new Error('The desktop bridge is unavailable.'));
    }

    const id = `ui-${nextHostRequestId++}`;
    return new Promise((resolve, reject) => {
        pendingHostRequests.set(id, { resolve, reject });
        hostBridge.postMessage({ id, method, params: params || null });
        window.setTimeout(() => {
            if (!pendingHostRequests.has(id)) return;
            pendingHostRequests.delete(id);
            reject(new Error('The desktop service did not respond.'));
        }, 30000);
    });
}

function crestColor(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = value.charCodeAt(i) + ((hash << 5) - hash);
    }
    return CREST_PALETTE[Math.abs(hash) % CREST_PALETTE.length];
}

function displayDashboardError(message) {
    $('#dashboardErrorText').textContent = message;
    $('#dashboardError').hidden = false;
}

function hideDashboardError() {
    $('#dashboardError').hidden = true;
    $('#dashboardErrorText').textContent = '';
}

function showSoloCommandError(message) {
    const content = $('#soloContent');
    const onboardAuth = $('#soloScreen.is-onboard .onboard-auth');
    if (onboardAuth) {
        let alert = onboardAuth.querySelector('.onboard-err.command-result');
        if (!alert) {
            alert = document.createElement('div');
            alert.className = 'onboard-err command-result';
            alert.setAttribute('role', 'alert');
            alert.innerHTML = `
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
                <span></span>`;
            onboardAuth.appendChild(alert);
        }
        alert.querySelector('span').textContent = message;
        return;
    }

    const target = content.querySelector('.consent-pane') || content;
    let alert = target.querySelector('.inline-err.command-result');
    if (!alert) {
        alert = document.createElement('div');
        alert.className = 'inline-err command-result';
        alert.setAttribute('role', 'alert');
        target.appendChild(alert);
    }
    alert.textContent = message;
}

function setSoloPresentation(options = {}) {
    const solo = $('#soloScreen');
    solo.classList.toggle('is-onboard', Boolean(options.onboard));
    solo.classList.toggle('is-restore', Boolean(options.restore));
}

function setDesignState(state) {
    // No console output in the shipped UI; DESIGN_STATE_COVERAGE membership is a
    // build-time invariant (unknown states never occur in production).
    document.body.dataset.designState = state;
}

function requestWindowMode(mode) {
    if (requestedWindowMode === mode) return;
    const size = WINDOW_MODES[mode];
    if (!size) return;
    requestedWindowMode = mode;
    windowResizePending = true;
    sendHostRequest('resize_window', { mode, width: size.width, height: size.height })
        .catch(() => {
            requestedWindowMode = null;
        })
        .finally(() => {
            windowResizePending = false;
            fitCanvasesToViewport();
        });
}

/* ── viewport self-fit ──────────────────────────────────────────────────
   The canvases are fixed-pixel designs that assume 1 CSS px == 1 window DIP.
   OS-level multipliers break that assumption: Windows text scaling
   (Settings > Accessibility > Text size) is folded into WebView2's
   rasterization scale — the WPF window keeps its DIP size while the CSS
   viewport shrinks — and a small work area can clamp the host window below
   the design size. Either way the viewport reports what actually fits, so
   the visible canvas scales down to match (field incident 2026-07-06: 150%
   text scale rendered every screen 1.5x larger than the NoResize window and
   the consent CTA was unreachable). An exact-fit viewport is a no-op. */
function fitCanvas(canvas, design) {
    let zoom = '';
    if (canvas.style.display !== 'none' &&
        (window.innerWidth < design.width || window.innerHeight < design.height)) {
        // 1px of slack absorbs fractional viewport rounding so a fitted
        // canvas can never re-introduce overflow; the floor guards
        // degenerate viewport reads mid window-resize.
        zoom = String(Math.max(0.2, Math.min(
            (window.innerWidth - 1) / design.width,
            (window.innerHeight - 1) / design.height,
        )));
    }
    if (canvas.style.zoom !== zoom) canvas.style.zoom = zoom;
}

function fitCanvasesToViewport() {
    // Hold while a host resize is in flight — the pre-resize viewport would
    // misfit the canvas the resize is for; the resize_window completion and
    // the window resize event both land back here once it settles.
    if (windowResizePending) return;
    fitCanvas($('#soloScreen'), WINDOW_MODES.solo);
    fitCanvas($('#dashboard'), WINDOW_MODES.dashboard);
}

window.addEventListener('resize', fitCanvasesToViewport);
fitCanvasesToViewport();

function showActionError(error, fallback) {
    const message = errorMessage(error, fallback);
    if ($('#dashboard').style.display !== 'none') {
        dashboardCommandError = message;
        displayDashboardError(message);
    } else {
        showSoloCommandError(message);
    }
}

async function sendCommand(method, params) {
    return await sendHostRequest(method, params);
}

async function cmd(method, params) {
    dashboardCommandError = null;
    hideDashboardError();
    try {
        const result = await sendCommand(method, params);
        if (result && result.auth && result.recording) {
            snapshot = result;
            render();
        }
        return result;
    } catch (error) {
        showActionError(error, 'That action could not be completed.');
        return null;
    }
}

async function startSignIn() {
    pendingSignIn = true;
    renderSigningIn();
    const result = await cmd('sign_in');
    if (result === null && (!snapshot || !snapshot.auth || snapshot.auth.state !== 'SigningIn')) {
        pendingSignIn = false;
        render();
    }
}

function setSignOutBusy(value) {
    signOutBusy = value;
    ['#btnSignOut', '#btnSignOutSolo'].forEach((selector) => {
        const button = $(selector);
        if (button) button.disabled = value;
    });
}

async function signOut() {
    if (signOutBusy) return;
    setSignOutBusy(true);
    try {
        await cmd('sign_out');
    } finally {
        setSignOutBusy(false);
    }
}

function showStepStrip(step1Class, step2Class, step3Class) {
    $('#stepStrip').style.display = '';
    $('#step1').className = step1Class || '';
    $('#step2').className = step2Class || '';
    $('#step3').className = step3Class || '';
}

function hideStepStrip() {
    $('#stepStrip').style.display = 'none';
}

function showSoloScreen() {
    requestWindowMode('solo');
    $('#soloScreen').style.display = '';
    $('#dashboard').style.display = 'none';
    fitCanvasesToViewport();
}

function renderBridgeConnecting() {
    setDesignState('05_restoring');
    showSoloScreen();
    setSoloPresentation();
    hideStepStrip();
    $('#soloContent').innerHTML = `
        <div class="solo-mark" style="opacity: 0.18;">kuro</div>
        <div class="spinner" style="margin-top: 4px;"></div>
        <p class="solo-sub" style="margin-top: 14px;">Connecting to the recorder.</p>`;
}

function renderBridgeError(error) {
    setDesignState('06_sign_in_error');
    showSoloScreen();
    setSoloPresentation();
    hideStepStrip();
    $('#soloContent').innerHTML = `
        <div class="state-icon warn">
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>
            </svg>
        </div>
        <h1 class="solo-headline">Unable to connect.</h1>
        <p class="solo-sub">${escapeHtml(errorMessage(error, 'The recorder service is unavailable.'))}</p>
        <button class="btn" id="btnRetryBridge" type="button">Retry</button>`;
    $('#btnRetryBridge').addEventListener('click', boot);
}

async function boot() {
    renderBridgeConnecting();
    if (!hostBridge) {
        renderBridgeError('The desktop bridge is unavailable.');
        return;
    }

    try {
        const initial = await sendCommand('get_snapshot');
        if (initial) {
            snapshot = initial;
            if (snapshot.auth && snapshot.auth.state !== 'SigningIn') {
                pendingSignIn = false;
            }
            syncThemeWithHost(initial);
            render();
        }
    } catch (error) {
        renderBridgeError(error);
    }
}

function render() {
    if (!snapshot) return;
    const authState = snapshot.auth && snapshot.auth.state;
    const account = authState === 'SignedIn' ? (snapshot.auth.user_id || snapshot.auth.email) : null;
    const sessionGeneration = snapshot.auth?.session_generation ?? null;
    if (account !== dashboardAccount || sessionGeneration !== dashboardSessionGeneration) {
        dashboardAccount = account;
        dashboardSessionGeneration = sessionGeneration;
        resetDashboardState();
    }

    if (authState === 'SignedOut' && pendingSignIn) {
        stopPoll();
        showSoloScreen();
        renderSigningIn();
        return;
    }

    if (authState !== 'SignedIn') {
        stopPoll();
        resetDashboardState();
        dashboardCommandError = null;
        hideDashboardError();
        showSoloScreen();
        renderSoloScreen(snapshot);
        return;
    }

    if ((snapshot.update && snapshot.update.required) ||
        (snapshot.recording && snapshot.recording.state === 'UpdateRequired')) {
        stopPoll();
        dashboardCommandError = null;
        hideDashboardError();
        showOnboardingComplete = false;
        showSoloScreen();
        renderUpdateRequired(snapshot);
        return;
    }

    if (showOnboardingComplete) {
        stopPoll();
        dashboardCommandError = null;
        hideDashboardError();
        showSoloScreen();
        renderAllSet();
        return;
    }

    if (!snapshot.settings || !snapshot.settings.onboarding_completed) {
        stopPoll();
        dashboardCommandError = null;
        hideDashboardError();
        showSoloScreen();
        renderConsentReview();
        return;
    }

    $('#soloScreen').style.display = 'none';
    $('#dashboard').style.display = '';
    requestWindowMode('dashboard');
    fitCanvasesToViewport();
    renderDashboard(snapshot);
}

function renderSoloScreen(s) {
    const state = s.auth.state;
    switch (state) {
        case 'SignedOut':
            renderWelcome(s);
            break;
        case 'SigningIn':
            renderSigningIn();
            break;
        case 'Restoring':
            renderRestoring(s);
            break;
        case 'DeviceBanned':
            renderDeviceBanned(s);
            break;
        case 'UserBanned':
            renderUserBanned(s);
            break;
        case 'DeviceLinkedToOtherUser':
            renderDeviceLinked(s);
            break;
        default:
            renderWelcome(s);
            break;
    }
}

function termsLink() {
    return '<a href="https://trykuro.app/legal/terms" data-external-link>Terms of Service</a>';
}

function privacyPolicyLink() {
    return '<a href="https://trykuro.app/legal/privacy-policy" data-external-link>Privacy Policy</a>';
}

function legalDisclosure(className = 'solo-disclose') {
    return `<p class="${className}">By signing in, you can review our ${termsLink()} and ${privacyPolicyLink()} before recording starts.</p>`;
}

// Every anchor tagged data-external-link opens through the host (WebView2 has
// no window.open target). showActionError routes the failure to the solo pill
// or the dashboard error bar, whichever surface is showing.
function bindExternalLinks(context = $('#soloContent')) {
    $$('[data-external-link]', context).forEach((link) => {
        link.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await sendCommand('open_external_url', { url: link.href });
            } catch (error) {
                showActionError(error, 'Could not open the link.');
            }
        });
    });
}

function renderSignupPaused() {
    setDesignState('signup_paused');
    hideStepStrip();
    setSoloPresentation({ onboard: true });
    $('#soloContent').innerHTML = `
        <div class="onboard-split">
            <div class="onboard-icon-pane">${KURO_MARK_SVG}</div>
            <div class="onboard-content-pane">
                <h1 class="signup-pause-title">Sign-ups are currently paused.</h1>
                <p class="signup-pause-copy">We couldn’t create a new account. Already a contributor? Sign in with the Google account you registered with.</p>
                <div class="onboard-auth">
                    <button class="google-cta-block" id="btnGoogleSignIn" type="button">${GOOGLE_SVG} Sign in with another account</button>
                    <a class="onboard-cancel" href="https://trykuro.app" data-external-link>Visit the Kuro website</a>
                </div>
            </div>
        </div>`;
    $('#btnGoogleSignIn').addEventListener('click', startSignIn);
    bindExternalLinks();
}

function renderWelcome(s) {
    if (s.auth && s.auth.last_error_code === 'signup_disabled') {
        renderSignupPaused();
        return;
    }
    setDesignState(s.auth && s.auth.last_error ? '06_sign_in_error' : '01_welcome');
    hideStepStrip();
    setSoloPresentation({ onboard: true });
    const authError = s.auth && s.auth.last_error;
    const errorHtml = authError ? `
        <div class="onboard-err" role="alert">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
            <span>${escapeHtml(authError)}</span>
            <button type="button" id="btnDismissAuthError" aria-label="Dismiss sign-in error"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg></button>
        </div>` : '';
    $('#soloContent').innerHTML = `
        <div class="onboard-split">
            <div class="onboard-icon-pane">${KURO_MARK_SVG}</div>
            <div class="onboard-content-pane">
                <h1>Get paid to<br/>use your computer.</h1>
                <div class="onboard-auth">
                    <button class="google-cta-block" id="btnGoogleSignIn" type="button">
                        ${GOOGLE_SVG}
                        Continue with Google
                    </button>
                    ${errorHtml}
                    ${legalDisclosure('onboard-terms')}
                </div>
            </div>
        </div>`;
    $('#btnGoogleSignIn').addEventListener('click', startSignIn);
    const dismiss = $('#btnDismissAuthError');
    if (dismiss) {
        dismiss.addEventListener('click', () => dismiss.closest('.onboard-err').remove());
    }
    bindExternalLinks();
}

function renderSigningIn() {
    setDesignState('02_signing_in');
    hideStepStrip();
    setSoloPresentation({ onboard: true });
    $('#soloContent').innerHTML = `
        <div class="onboard-split">
            <div class="onboard-icon-pane">${KURO_MARK_SVG}</div>
            <div class="onboard-content-pane">
                <h1>Get paid to<br/>use your computer.</h1>
                <div class="onboard-auth">
                    <button class="google-cta-block" type="button" disabled>
                        <span class="inline-spinner is-light"></span>
                        Waiting for Google
                    </button>
                    <button class="onboard-cancel" id="btnCancelSignIn" type="button">Cancel</button>
                </div>
            </div>
        </div>`;
    $('#btnCancelSignIn').addEventListener('click', () => {
        pendingSignIn = false;
        cmd('cancel_sign_in');
    });
}

function renderRestoring(s) {
    setDesignState('05_restoring');
    hideStepStrip();
    setSoloPresentation({ onboard: true, restore: true });
    $('#soloContent').innerHTML = `
        <div class="onboard-split">
            <div class="onboard-icon-pane">${KURO_MARK_SVG}</div>
            <div class="onboard-content-pane">
                <h1>Get paid to<br/>use your computer.</h1>
                <div class="onboard-auth">
                    <button class="google-cta-block" type="button" disabled>
                        <span class="inline-spinner is-light"></span>
                        Restoring
                    </button>
                </div>
            </div>
        </div>`;
}

function renderDeviceBanned(s) {
    setDesignState('08_device_suspended');
    hideStepStrip();
    setSoloPresentation();
    const reason = s.auth.ban_reason || 'Reach your admin to investigate.';
    $('#soloContent').innerHTML = `
        <div class="state-icon bad">
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>
            </svg>
        </div>
        <h1 class="solo-headline">Device suspended.</h1>
        <p class="solo-sub">${escapeHtml(reason)}</p>
        <button class="btn" id="btnSignOutSolo" type="button">Sign out</button>`;
    $('#btnSignOutSolo').addEventListener('click', signOut);
}

function renderUserBanned(s) {
    setDesignState('09_account_suspended');
    hideStepStrip();
    setSoloPresentation();
    $('#soloContent').innerHTML = `
        <div class="state-icon bad">
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9"/><path d="M4.93 4.93l14.14 14.14"/>
            </svg>
        </div>
        <h1 class="solo-headline">Account suspended.</h1>
        <p class="solo-sub">This account cannot record right now. Contact support if this looks wrong.</p>
        <button class="btn" id="btnSignOutSolo" type="button">Sign out</button>`;
    $('#btnSignOutSolo').addEventListener('click', signOut);
}

function renderDeviceLinked(s) {
    setDesignState('10_device_linked');
    hideStepStrip();
    setSoloPresentation();
    const linkedEmail = s.auth.linked_email || 'another account';
    $('#soloContent').innerHTML = `
        <div class="state-icon warn">
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/>
                <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>
            </svg>
        </div>
        <h1 class="solo-headline">Already linked.</h1>
        <p class="solo-sub">Linked to <strong>${escapeHtml(linkedEmail)}</strong>. One account per device.</p>
        <button class="btn" id="btnSwitchAccount" type="button">Switch account</button>`;
    $('#btnSwitchAccount').addEventListener('click', startSignIn);
}

function renderUpdateRequired(s) {
    setDesignState('11_update_required');
    hideStepStrip();
    setSoloPresentation();
    const targetVersion = s.update && s.update.available_version;
    const versionText = targetVersion
        ? `Kuro <strong>v${escapeHtml(targetVersion)}</strong> is required to continue recording.`
        : 'A required Kuro update is available.';
    const updateError = s.update && s.update.last_error;
    const errorHtml = updateError
        ? `<div class="inline-err" role="alert">${escapeHtml(updateError)}</div>`
        : '';
    $('#soloContent').innerHTML = `
        <div class="state-icon outline">
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 4v12"/><path d="M6 14l6 6 6-6"/>
            </svg>
        </div>
        <h1 class="solo-headline">Update required.</h1>
        <p class="solo-sub">${versionText}</p>
        <div class="solo-actions">
            <button class="btn-primary" id="btnRestart" type="button">Restart now</button>
        </div>
        ${errorHtml}`;
    $('#btnRestart').addEventListener('click', () => cmd('install_update'));
}

function renderConsentReview() {
    setDesignState('03_review_agree');
    showStepStrip('done', 'active', '');
    setSoloPresentation();
    $('#soloContent').innerHTML = `
        <div class="consent-pane">
            <div class="state-icon good">
                <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/>
                </svg>
            </div>
            <h1 class="consent-headline">Before Kuro starts.</h1>
            <div class="consent-list">
                <label class="consent-row">
                    <input class="consent-input" id="consentLegal" type="checkbox" />
                    <span class="consent-box" aria-hidden="true"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg></span>
                    <span class="consent-copy">I agree to Kuro's ${termsLink()} and ${privacyPolicyLink()}.</span>
                </label>
                <label class="consent-row">
                    <input class="consent-input" id="consentAge" type="checkbox" />
                    <span class="consent-box" aria-hidden="true"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg></span>
                    <span class="consent-copy">I'm at least 18 and consent to Kuro recording my screen activity.</span>
                </label>
            </div>
            <button class="btn-primary consent-cta" id="btnAgreeContinue" type="button" disabled>Agree &amp; continue</button>
        </div>`;

    const legal = $('#consentLegal');
    const age = $('#consentAge');
    const cta = $('#btnAgreeContinue');
    const syncConsent = () => {
        $$('.consent-row').forEach((row) => {
            const input = row.querySelector('.consent-input');
            row.classList.toggle('is-checked', Boolean(input && input.checked));
        });
        cta.disabled = !(legal.checked && age.checked);
    };
    [legal, age].forEach((input) => input.addEventListener('change', syncConsent));
    cta.addEventListener('click', async () => {
        if (cta.disabled) return;
        cta.disabled = true;
        cta.textContent = 'Saving...';
        // Set before the await: the host starts recording during this command
        // and broadcasts snapshots with onboarding_completed=true that can
        // arrive ahead of the response — without the flag those renders fall
        // through to the dashboard and flash the full-size window.
        showOnboardingComplete = true;
        try {
            const result = await sendCommand('complete_onboarding');
            if (result && result.auth && result.recording) {
                snapshot = result;
            }
            render();
        } catch (error) {
            showOnboardingComplete = false;
            if (cta.isConnected) {
                showActionError(error, 'Could not save consent.');
                cta.textContent = 'Agree & continue';
                syncConsent();
            } else {
                // A mid-save snapshot re-rendered the screen; rebuild the
                // consent view before surfacing the error.
                render();
                showActionError(error, 'Could not save consent.');
            }
        }
    });
    bindExternalLinks();
    syncConsent();
}

function renderAllSet() {
    setDesignState('04_all_set');
    showStepStrip('done', 'done', 'active');
    setSoloPresentation();
    $('#soloContent').innerHTML = `
        <div class="state-icon ink">
            <svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7"/>
            </svg>
        </div>
        <h1 class="solo-headline">You're all set.</h1>
        <p class="solo-sub">Kuro is running in the background.</p>
        <button class="btn-primary" id="btnGotIt" type="button">Got it</button>`;
    $('#btnGotIt').addEventListener('click', () => {
        showOnboardingComplete = false;
        render();
    });
}

function renderDashboard(s) {
    communications.retry();
    renderRecording(s);
    renderMeta(s);
    renderUserIdentity(s);
    renderStartup(s);
    renderUpdateStatus(s);

    if (dashboardCommandError) {
        displayDashboardError(dashboardCommandError);
    } else {
        hideDashboardError();
    }

    if (!initializedView) {
        initializedView = true;
        setView(requestedInitialView);
    }

    ensureBundleLoaded();
    managePoll();
}

function renderUpdateStatus(s) {
    const update = s.update || {};
    const status = update.status || 'idle';
    const availableVersion = update.available_version || '';
    const currentVersion = s.app && s.app.version ? s.app.version : '';
    const checkButton = $('#btnCheckUpdates');
    const updateStatus = $('#updateStatus');
    const updateIcon = $('#updateStatusIcon');
    const installButton = $('#btnInstallUpdate');

    checkButton.classList.toggle('checking', status === 'checking');
    checkButton.classList.toggle('has-update', status === 'available');
    checkButton.disabled = status === 'checking';
    checkButton.innerHTML = status === 'checking'
        ? `<span class="inline-spinner" aria-hidden="true"></span><span>Checking...</span><span class="badge-dot"></span>`
        : `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7-3.5"></path>
                <path d="M3 21v-5h5"></path>
                <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7 3.5"></path>
                <path d="M21 3v5h-5"></path>
            </svg><span>${status === 'error' ? 'Try again' : 'Check updates'}</span><span class="badge-dot"></span>`;

    updateStatus.hidden = true;
    updateStatus.className = 'update-card loaded-only';
    installButton.hidden = true;

    if (status === 'up_to_date') {
        updateStatus.hidden = false;
        updateStatus.classList.add('good');
        updateIcon.innerHTML = UPDATE_ICONS.check;
        $('#updateStatusTitle').textContent = "You're up to date.";
        $('#updateStatusCopy').textContent = currentVersion
            ? `Kuro v${currentVersion} is the latest version.`
            : 'You have the latest version of Kuro.';
        return;
    }

    if (status === 'available') {
        updateStatus.hidden = false;
        updateStatus.classList.add('available');
        updateIcon.innerHTML = UPDATE_ICONS.download;
        $('#updateStatusTitle').textContent = availableVersion
            ? `Kuro v${availableVersion} is available.`
            : 'A Kuro update is available.';
        $('#updateStatusCopy').textContent = 'Restart to install.';
        installButton.hidden = false;
        return;
    }

    if (status === 'error') {
        updateStatus.hidden = false;
        updateStatus.classList.add('bad');
        updateIcon.innerHTML = UPDATE_ICONS.warn;
        $('#updateStatusTitle').textContent = 'Could not check for updates.';
        $('#updateStatusCopy').textContent = 'Check your connection and try again.';
    }
}

function setStateBadge(text) {
    const badge = $('#recordingStateBadge');
    badge.textContent = text;
    badge.style.display = 'inline-flex';
    $('#recordingButton').style.display = 'none';
}

function setRecordingButton(label, stop, disabled, loading = false) {
    const button = $('#recordingButton');
    $('#recordingStateBadge').style.display = 'none';
    button.style.display = '';
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.classList.toggle('stop', Boolean(stop) && !loading);
    button.classList.toggle('loading', Boolean(loading));
}

function recordingTransitionLabel(transition) {
    if (transition === 'starting') return 'Starting...';
    if (transition === 'stopping') return 'Stopping...';
    return null;
}

function privacyPauseCopy() {
    return 'Resumes when privacy clears.';
}

function isSelfAppPause(masking) {
    return masking && masking.context_type === 'self_app';
}

function pausedRecordingTitle(masking) {
    return isSelfAppPause(masking) ? 'Kuro is open.' : 'Paused for privacy.';
}

function pausedRecordingCopy(masking) {
    return isSelfAppPause(masking)
        ? 'Switch apps to resume.'
        : privacyPauseCopy();
}

function pausedRecordingPill(masking) {
    return isSelfAppPause(masking) ? 'APP' : 'PRIV';
}

function pausedRecordingBadge(masking) {
    return isSelfAppPause(masking) ? 'Kuro' : 'Privacy';
}

function renderRecording(s) {
    const dash = $('#dashboard');
    const recording = s.recording || {};
    const sync = s.desktop_sync || {};
    const state = recording.state || 'Idle';
    const privacyPaused = state === 'PrivacyPaused' ||
        (s.masking && s.masking.status === 'privacy_paused');
    const lowDisk = state === 'LowDisk' || Boolean(s.disk && s.disk.low_disk);
    const hasConfig = Boolean(sync.has_config);
    const transition = recording.transition;
    const transitionLabel = recordingTransitionLabel(transition);
    const canStopActiveSession = recording.manual_controls_allowed && Boolean(recording.has_active_session);

    dash.dataset.recording = 'paused';
    $('#recPillLabel').textContent = 'OFF';
    $('#recordingButton').disabled = true;
    $('#recordingButton').classList.remove('stop');
    $('#recordingButton').style.display = 'none';
    $('#recordingStateBadge').style.display = 'none';

    if (privacyPaused) {
        setDesignState('12_privacy_paused');
        dash.dataset.recording = 'privacy';
        $('#recPillLabel').textContent = pausedRecordingPill(s.masking);
        $('#recCardTitle').textContent = pausedRecordingTitle(s.masking);
        $('#recCardLabel').textContent = pausedRecordingCopy(s.masking);
        if (canStopActiveSession) {
            setRecordingButton(transitionLabel || 'Stop recording', true, Boolean(transitionLabel), Boolean(transitionLabel));
        } else {
            setStateBadge(pausedRecordingBadge(s.masking));
        }
        return;
    }

    setDesignState('runtime_dashboard');

    if (lowDisk) {
        $('#recPillLabel').textContent = 'LOW';
        $('#recCardTitle').textContent = 'Low disk space.';
        $('#recCardLabel').textContent = 'Free up storage to resume recording.';
        setRecordingButton('Start recording', false, true);
        return;
    }

    // The bridge has always shipped this; without the branch, Start silently
    // no-op'd on 3+ displays with zero explanation.
    if (recording.unsupported_topology_reason) {
        $('#recPillLabel').textContent = 'OFF';
        $('#recCardTitle').textContent = 'Display setup not supported.';
        $('#recCardLabel').textContent = 'Recording supports one or two extended displays. Disconnect extra displays to resume.';
        setStateBadge('Displays');
        return;
    }

    if (!hasConfig) {
        $('#recCardTitle').textContent = state === 'Recording' ? 'Recording.' : 'Not recording.';
        $('#recCardLabel').textContent = sync.last_error
            ? 'App config could not be synced.'
            : 'Syncing app config.';
        setRecordingButton(
            transitionLabel || (state === 'Recording' ? 'Stop recording' : 'Start recording'),
            state === 'Recording',
            Boolean(transitionLabel) || !recording.manual_controls_allowed,
            Boolean(transitionLabel));
        return;
    }

    if (state === 'Paused') {
        $('#recPillLabel').textContent = 'IDLE';
        $('#recCardTitle').textContent = 'Paused while idle.';
        $('#recCardLabel').textContent = 'Recording resumes when activity returns.';
        if (recording.manual_controls_allowed) {
            setRecordingButton(transitionLabel || 'Stop recording', true, Boolean(transitionLabel), Boolean(transitionLabel));
        } else {
            setStateBadge('Idle');
        }
        return;
    }

    if (state === 'Recording') {
        dash.dataset.recording = 'active';
        $('#recPillLabel').textContent = 'REC';
        $('#recCardTitle').textContent = 'Recording.';
        $('#recCardLabel').textContent = 'All sessions syncing.';
        setRecordingButton(transitionLabel || 'Stop recording', true, Boolean(transitionLabel), Boolean(transitionLabel));
        return;
    }

    $('#recCardTitle').textContent = 'Not recording.';
    $('#recCardLabel').textContent = 'No new sessions captured.';
    setRecordingButton(
        transitionLabel || 'Start recording',
        false,
        Boolean(transitionLabel) || !recording.manual_controls_allowed,
        Boolean(transitionLabel));
}

function renderMeta(s) {
    $('#metaVersion').textContent = s.app && s.app.version
        ? `v${s.app.version}`
        : '';
}

function renderUserIdentity(s) {
    const email = (s.auth && s.auth.email) || '';
    $('#userName').textContent = email;
    $('#userEmail').textContent = 'Signed in';
    const crest = $('#userCrest');
    crest.textContent = email ? email[0].toUpperCase() : '';
    if (email) crest.style.setProperty('--crest-bg', crestColor(email));
}

function renderStartup(s) {
    const settings = s.settings || {};
    const desired = Boolean(settings.launch_at_startup);
    const registered = Boolean(settings.launch_at_startup_registered);
    const needsAttention = desired && !registered;
    const enabled = registered;
    $$('#startupSeg button').forEach((button) => {
        const active = String(enabled) === button.dataset.val;
        button.classList.toggle('active', active);
        button.classList.toggle('off', active && !enabled);
        button.setAttribute('aria-pressed', String(active));
    });
    $('#startupIcon').classList.toggle('granted', enabled);
    $('#startupCopy').textContent = enabled
        ? 'Starts Kuro in the background at Linux session login.'
        : needsAttention
            ? 'Startup is enabled, but the Linux session registration is missing.'
            : 'Kuro will start only when you launch it.';
    $('#permSub').textContent = 'Required desktop access for recording.';
}

function setView(requestedView) {
    const view = requestedView;
    const previousView = currentView;
    currentView = view;
    $$('.side-tab[data-view]').forEach((tab) => {
        const active = tab.dataset.view === view;
        tab.classList.toggle('active', active);
        if (active) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    });
    $$('.view').forEach((panel) => {
        const active = panel.id === `${view}View`;
        panel.classList.toggle('active', active);
        panel.setAttribute('aria-hidden', String(!active));
    });
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    onViewChanged(previousView, view);
}

$$('.side-tab[data-view]').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
});

$('#recordingButton').addEventListener('click', () => {
    if (!snapshot || $('#recordingButton').disabled) return;
    const state = snapshot.recording && snapshot.recording.state;
    const hasActiveSession = Boolean(snapshot.recording && snapshot.recording.has_active_session);
    cmd(state === 'Recording' || state === 'Paused' || hasActiveSession
        ? 'stop_recording'
        : 'start_recording');
});

$$('#startupSeg button').forEach((button) => {
    button.addEventListener('click', () => {
        cmd('set_launch_at_startup', { enabled: button.dataset.val === 'true' });
    });
});

$('#btnSignOut').addEventListener('click', signOut);
$('#btnFaq').addEventListener('click', async () => {
    try {
        await sendCommand('open_external_url', { url: 'https://trykuro.app/faq' });
    } catch (error) {
        showActionError(error, 'Could not open the link.');
    }
});
$('#btnCheckUpdates').addEventListener('click', () => cmd('check_updates'));
$('#btnInstallUpdate').addEventListener('click', () => cmd('install_update'));
$('#btnQuit').addEventListener('click', async () => {
    if (quitBusy) return;
    quitBusy = true;
    $('#btnQuit').disabled = true;
    // cmd() never rejects — it surfaces the error in the dashboard bar and
    // returns null (the file's established idiom). The old .catch was dead
    // code, so a failed quit wedged the button until restart.
    const result = await cmd('quit');
    if (result === null) {
        quitBusy = false;
        $('#btnQuit').disabled = false;
    }
});

async function hideWindow() {
    try {
        await sendCommand('hide_window');
    } catch (error) {
        showActionError(error, 'The window could not be hidden.');
    }
}

$('#soloClose').addEventListener('click', hideWindow);
$('#dashClose').addEventListener('click', hideWindow);

/* ---- theme (light / dark) ----------------------------------------------
   Applied on <body> so the tokens flip for the solo and dashboard windows
   alike. Two stores, one owner:
   - localStorage "kuro-theme" is the paint cache — read synchronously at
     load, before first paint, so dark users never see a light flash.
   - The host mirrors the value in UserSettings (set_theme command) purely
     so the next launch can pre-paint the WPF window and WebView2 surface.
   At boot the two reconcile: an empty localStorage (fresh or recreated
   WebView2 profile) adopts the host's durable copy; otherwise localStorage
   is the user's latest action and re-pushes, healing a lost host write. */
let currentTheme = 'light';
let themeStoredLocally = false;

function applyTheme(theme) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    if (currentTheme === 'dark') document.body.dataset.theme = 'dark';
    else delete document.body.dataset.theme;
    const btn = $('#themeToggle');
    if (btn) btn.setAttribute('aria-label', currentTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    const label = $('#themeLabel');
    if (label) label.textContent = currentTheme === 'dark' ? 'Light mode' : 'Dark mode';
}

function syncThemeWithHost(s) {
    const hostTheme = s && s.settings && s.settings.theme;
    if (hostTheme !== 'dark' && hostTheme !== 'light') return;
    if (!themeStoredLocally) {
        if (hostTheme !== currentTheme) applyTheme(hostTheme);
        try { localStorage.setItem('kuro-theme', hostTheme); } catch (error) {}
        themeStoredLocally = true;
        return;
    }
    if (hostTheme !== currentTheme) {
        sendCommand('set_theme', { theme: currentTheme }).catch(() => {});
    }
}

(() => {
    let stored = null;
    try { stored = localStorage.getItem('kuro-theme'); } catch (error) {}
    themeStoredLocally = stored === 'dark' || stored === 'light';
    applyTheme(stored === 'dark' ? 'dark' : 'light');
    const btn = $('#themeToggle');
    if (btn) btn.addEventListener('click', () => {
        const next = currentTheme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        themeStoredLocally = true;
        try { localStorage.setItem('kuro-theme', next); } catch (error) {}
        sendCommand('set_theme', { theme: next }).catch(() => {});
    });
})();

/* =========================================================================
   Dashboard data layer (web-dashboard consolidation)
   -------------------------------------------------------------------------
   Driven entirely by the new request/response bridge commands — never the
   broadcast snapshot, never a token, never fetch(). Money stays micro-USD
   integers until the final format call. All server-derived strings are
   escaped; notice CTA actions dispatch through an allowlist, never an
   interpolated attribute.
   ========================================================================= */

const PAGE_SIZE = 15;
const CLIPS_VISIBLE = 10;
const CACHE_LIMIT = 3;

let dashboardData = null;
let dashboardGeneration = 0;
let dashboardAccount = null;
let dashboardSessionGeneration = null;
const communications = KuroCommunications.create({
    doc: document, send: callData, visible: isDashboardVisible,
    currentView: () => currentView, navigate: setView,
    external: url => sendCommand('open_external_url', { url }).catch(() => {}),
});
let communicationsRequest = null;
let communicationsSupported = false;
let communicationsAttempted = false;
let communicationsLegacyFallback = false;
let referralData = null;
let referralLoaded = false;
let bundleErrorCode = null;
let referralErrorCode = null;
let lastDashFetchAt = 0;
let lastRefFetchAt = 0;

let histTab = 'recordings';
const histState = {
    recordings: { offset: 0, page: null },
    transactions: { offset: 0, page: null },
};
const recordingsCache = new Map();   // offset -> page envelope
const ledgerCache = new Map();       // offset -> page envelope
const segmentsCache = new Map();     // session_id -> segment[] (or { __error:true })
const openSessions = new Set();      // expanded session ids (accordion: 0 or 1)
const showAllSessions = new Set();   // session ids showing all clips
let dismissedFlashId = null;         // payout id whose result banner (rejection or claim) was dismissed
let selectedMethodKey = null;        // payout form method — falls back to the first served method
let typedDestination = '';           // typed UPI value; survives method toggles (the input node does not)
let instantResult = null;            // flash for this session's last instant payout outcome
let payoutConfirm = null;            // { method, destination } behind the open confirm dialog
let payoutSubmitting = false;
let pollTimer = null;

/* ---- formatting -------------------------------------------------------- */

function formatMicroUsd(micro) {
    const currency = String((dashboardData && dashboardData.display_currency) || 'INR').toUpperCase();
    const usdToInrRate = Number((dashboardData && dashboardData.usd_to_inr_rate) || 100);
    const usd = (Number(micro) || 0) / 1000000;
    if (currency === 'USD') {
        return usd.toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }
    const rate = Number.isFinite(usdToInrRate) && usdToInrRate > 0 ? usdToInrRate : 100;
    return (usd * rate).toLocaleString('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

// All durations are wording-based (web formatDurationParts /
// formatDurationFromMs semantics): only the units that exist are shown —
// two adjacent units with the minor one zero-padded, seconds dropped once
// hours appear. 412hr 06min · 4min 02sec · 45sec (summary card) and
// 1h 04m · 4m 02s · 2s (history table).
function durationParts(ms) {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hr = Math.floor(totalSeconds / 3600);
    const min = Math.floor((totalSeconds % 3600) / 60);
    const sec = totalSeconds % 60;
    if (hr > 0) return [[String(hr), 'hr'], [String(min).padStart(2, '0'), 'min']];
    if (min > 0) return [[String(min), 'min'], [String(sec).padStart(2, '0'), 'sec']];
    return [[String(sec), 'sec']];
}

function fmtDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hr = Math.floor(totalSeconds / 3600);
    const min = Math.floor((totalSeconds % 3600) / 60);
    const sec = totalSeconds % 60;
    if (hr > 0) return `${hr}h ${String(min).padStart(2, '0')}m`;
    if (min > 0) return `${min}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatSessionDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const hours = d.getHours();
    const hour12 = hours % 12 || 12;
    const ampm = hours < 12 ? 'AM' : 'PM';
    return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${hour12}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function escapeAttr(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ---- category vocabulary ---------------------------------------------- */

const CATEGORY_LABELS = {
    coding: 'Coding', design: 'Design', research: 'Research', productivity: 'Productivity',
    finance: 'Finance', video_editing: 'Video Editing', gaming: 'Gaming', cad: 'CAD',
    general: 'General', scam: 'Unidentified', entertainment: 'Entertainment',
};
const CATEGORY_TOKENS = {
    coding: '--cat-coding', design: '--cat-design', research: '--cat-research',
    productivity: '--cat-productivity', finance: '--cat-finance', video_editing: '--cat-video',
    gaming: '--cat-gaming', cad: '--cat-cad', general: '--cat-general', scam: '--cat-scam',
    entertainment: '--cat-entertainment',
};
const RATE_EXCLUDED = new Set(['scam', 'capture_failure', 'invalid_media']);
function categoryLabel(slug) { return CATEGORY_LABELS[slug] || slug; }
function categoryToken(slug) { return CATEGORY_TOKENS[slug] || '--cat-general'; }

function catChipHTML(slug) {
    if (!slug) return '<span class="c-none">—</span>';
    const tok = categoryToken(slug);   // fixed CSS var name — not injectable
    const label = escapeHtml(categoryLabel(slug));
    return `<span class="cat-chip" style="--chip: var(${tok});">${label}</span>`;
}

/* ---- payout methods (registry served in the dashboard bundle) ---------- */

// Fallback when a served destination_regex is missing or invalid.
const UPI_RE = /^[a-zA-Z0-9._\-]{2,}@[a-zA-Z][a-zA-Z0-9.]{2,}$/;

const ZAP_SVG = '<svg class="zap" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4.5 13.5H11L9.5 22 19 10.5h-6.5L13 2z"></path></svg>';
const ARROW_NE_SVG = '<svg class="ne" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path></svg>';
const MAIL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1"></rect><path d="m3 7 9 6 9-6"></path></svg>';

// Payload-skew safety net (web FALLBACK_PAYOUT_METHODS): the payout form
// never renders without a method even if the served array is missing/empty.
const FALLBACK_PAYOUT_METHODS = [{
    method: 'upi', label: 'UPI', route: 'manual', destination_kind: 'upi_id', destination_regex: null,
}];

// Single-method head sub-copy; unknown registry methods get the generic line.
const PAY_SUB_COPY = { upi: 'Request UPI payout.', gift_card: 'Request a gift card payout.' };

function payoutMethods() {
    const served = (dashboardData && Array.isArray(dashboardData.payout_methods))
        ? dashboardData.payout_methods.filter((m) => m && m.method && m.label)
        : [];
    return served.length ? served : FALLBACK_PAYOUT_METHODS;
}

function selectedPayoutMethod(methods) {
    return methods.find((m) => m.method === selectedMethodKey) || methods[0];
}

function destinationRegexFor(method) {
    if (method.destination_regex) {
        try {
            return new RegExp(method.destination_regex);
        } catch (e) {
            // Served pattern is invalid — degrade to the hardcoded UPI format.
        }
    }
    return UPI_RE;
}

function isAccountEmailMethod(method) {
    return method.destination_kind === 'account_email';
}

// Gift-card requests store the resolved profile email as their destination;
// a request whose method is no longer served is judged by that signature.
function isAccountEmailRequest(request) {
    const match = payoutMethods().find((m) => m.method === request.method);
    if (match) return isAccountEmailMethod(match);
    return Boolean(request.destination) && request.destination === accountEmail();
}

function accountEmail() {
    return (dashboardData && dashboardData.profile && dashboardData.profile.email) ||
        (snapshot && snapshot.auth && snapshot.auth.email) || '';
}

function safeClaimUrl(url) {
    return (typeof url === 'string' && url.startsWith('https://')) ? url : null;
}

function claimLinkHTML(url) {
    return `<a class="claim-link" href="${escapeAttr(url)}" data-external-link>Claim your gift card${ARROW_NE_SVG}</a>`;
}

/* ---- error copy (never echo raw error.message to the UI) --------------- */

const DASHBOARD_ERROR_COPY = {
    below_minimum: "You're below the minimum payout amount.",
    duplicate_request: 'You already have a payout request in progress.',
    account_suspended: "This account can't request payouts right now.",
    invalid_wallet: 'That UPI ID looks invalid. Check it and try again.',
    method_disabled: 'This payout method is currently unavailable. Pick another method.',
    invalid_destination: 'That destination was rejected. Double-check it and try again.',
    too_many_sessions: 'Too much history to load at once. Try again shortly.',
    update_required: 'A required update is installing.',
    linux_payout_unavailable: 'Payout services are not connected in this Linux build.',
    profile_not_found: "We couldn't load your dashboard. Please retry.",
    unauthorized: 'Your session needs a refresh. Sign out and back in.',
    timeout: 'That took too long. Please retry.',
};
function errorCopy(err, fallback) {
    const code = err && err.code;
    if (code && DASHBOARD_ERROR_COPY[code]) return DASHBOARD_ERROR_COPY[code];
    return fallback || 'Something went wrong. Please retry.';
}

/* ---- bridge data helper (returns {ok,result|error}; never throws) ------ */

async function callData(method, params) {
    try {
        const result = await sendCommand(method, params);
        return { ok: true, result };
    } catch (err) {
        return { ok: false, error: err };
    }
}

function isDashboardVisible() {
    return document.visibilityState === 'visible' && $('#dashboard').style.display !== 'none';
}

function resetDashboardState() {
    dashboardGeneration++;
    communications.setAccount(dashboardAccount, true);
    communicationsRequest = null;
    communicationsSupported = false;
    communicationsAttempted = false;
    communicationsLegacyFallback = false;
    dashboardData = null;
    referralData = null;
    referralLoaded = false;
    bundleErrorCode = null;
    referralErrorCode = null;
    lastDashFetchAt = 0;
    lastRefFetchAt = 0;
    histTab = 'recordings';
    histState.recordings.offset = 0; histState.recordings.page = null;
    histState.transactions.offset = 0; histState.transactions.page = null;
    recordingsCache.clear(); ledgerCache.clear(); segmentsCache.clear();
    openSessions.clear(); showAllSessions.clear();
    dismissedFlashId = null; selectedMethodKey = null; typedDestination = '';
    instantResult = null; payoutConfirm = null; payoutSubmitting = false;
}

/* ---- conditional 30s poll (the UI's only timer) ----------------------- */

function currentRecordingsPageHasInFlightClips() {
    for (const segs of segmentsCache.values()) {
        if (Array.isArray(segs) && segs.some((seg) =>
            seg.clip_status === 'pending_upload' || seg.clip_status === 'processing')) return true;
    }
    return false;
}

function currentRecordingsPageHasPendingUploadSessions() {
    const page = histState.recordings.page;
    const rows = page && Array.isArray(page.rows) ? page.rows : [];
    return rows.some((session) => session.status === 'pending_upload');
}

function shouldPoll() {
    if (!isDashboardVisible()) return false;
    if (!communicationsSupported && communications.hasWarning()) return true;
    if (currentView !== 'earnings') return false;
    if (!dashboardData) return false;
    const summary = dashboardData.summary || {};
    if (dashboardData.active_payout_request) return true;
    if ((Number(summary.held_balance_microusd) || 0) > 0) return true;
    if (currentRecordingsPageHasPendingUploadSessions()) return true;
    if (currentRecordingsPageHasInFlightClips()) return true;
    return false;
}

function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function managePoll() {
    if (shouldPoll()) {
        if (!pollTimer) pollTimer = window.setInterval(pollTick, 30000);
    } else {
        stopPoll();
    }
}

function pollTick() {
    if (!shouldPoll()) { stopPoll(); return; }
    loadDashboard(true);
    refreshRecordingsPage();
    reloadOpenSessions();
}

/* ---- loads ------------------------------------------------------------- */

async function loadDashboard(force) {
    const now = Date.now();
    if (!force && now - lastDashFetchAt < 1000) return;
    lastDashFetchAt = now;
    const generation = dashboardGeneration;
    const res = await callData('get_dashboard', {});
    if (generation !== dashboardGeneration) return;
    if (res.ok && res.result) {
        dashboardData = res.result;
        const priorSignups = communications.signupsEnabled();
        communications.legacy(res.result);
        if (priorSignups !== communications.signupsEnabled()) renderReferralInvitation();
        bundleErrorCode = null;
        renderAccountExtras();
        renderPayouts();
        renderNotices();
        updateTabVisibility();
        managePoll();
    } else {
        const code = res.error && res.error.code;
        // 426 flips the snapshot to the update screen; don't paint a scary error.
        if (code === 'update_required') return;
        bundleErrorCode = code || 'timeout';
        renderPayouts();
        renderAccountExtras();
    }
}

async function loadReferral(force) {
    const now = Date.now();
    if (!force && now - lastRefFetchAt < 1000) return;
    lastRefFetchAt = now;
    const generation = dashboardGeneration;
    const res = await callData('get_referral', {});
    if (generation !== dashboardGeneration) return;
    referralLoaded = true;
    if (res.ok && res.result) {
        referralData = res.result;
        referralErrorCode = null;
        renderReferrals();
        updateTabVisibility();
    } else {
        const code = res.error && res.error.code;
        if (code === 'update_required') return;
        referralErrorCode = code || 'timeout';
        renderReferrals();
        updateTabVisibility();
    }
}

function ensureBundleLoaded() {
    if (!isDashboardVisible()) return;
    if (dashboardData == null && bundleErrorCode == null) loadDashboard();
    if (!communicationsAttempted) loadCommunications();
    if (!referralLoaded && referralErrorCode == null) loadReferral();
}

/* ---- view-change hooks ------------------------------------------------- */

function onViewChanged(previousView, view) {
    if (previousView === 'earnings' && view !== 'earnings') {
        // bounded memory: drop history caches on leaving the payouts view
        recordingsCache.clear(); ledgerCache.clear(); segmentsCache.clear();
        openSessions.clear(); showAllSessions.clear();
        histState.recordings.page = null;
        histState.transactions.page = null;
    }
    if (view === 'earnings') {
        loadDashboard();
        ensureHistoryPage();
    } else if (view === 'referrals') {
        loadReferral();
    }
    renderNotices();
    managePoll();
}

/* ---- notices ----------------------------------------------------------- */

// Only the shared module composes or renders notices. Native sync delivers
// independent updates; a communications read never repaints financial forms.
function renderNotices() { communications.render(); }

function isCurrentCommunications(value, eventOwner, eventSession) {
    if (!value || !snapshot?.auth || snapshot.auth.state !== 'SignedIn') return false;
    const owner = value.owner_user_id || eventOwner;
    if (!snapshot.auth.user_id || owner !== snapshot.auth.user_id ||
        (eventOwner && eventOwner !== owner)) return false;
    const generation = value.session_generation ?? eventSession;
    if (snapshot.auth.session_generation != null &&
        (generation !== snapshot.auth.session_generation ||
            (eventSession != null && eventSession !== generation))) return false;
    return true;
}

function acceptCommunicationsUnsupported(value, eventOwner, eventSession) {
    if (!isCurrentCommunications(value, eventOwner, eventSession)) return false;
    communications.useLegacy();
    communicationsSupported = false;
    managePoll();
    if (!communicationsLegacyFallback) {
        communicationsLegacyFallback = true;
        loadDashboard(true);
    }
    return true;
}

function acceptCommunications(value, eventOwner, eventSession) {
    if (!isCurrentCommunications(value, eventOwner, eventSession)) return false;
    const priorSignups = communications.signupsEnabled();
    if (!communications.apply(value)) return false;
    communicationsSupported = true;
    communicationsLegacyFallback = false;
    if (priorSignups !== communications.signupsEnabled()) renderReferralInvitation();
    managePoll();
    return true;
}

async function loadCommunications(force) {
    if (!isDashboardVisible() || !dashboardAccount || communicationsRequest) return;
    const generation = dashboardGeneration;
    communicationsAttempted = true;
    const request = callData('get_communications', { force: force === true });
    communicationsRequest = request;
    try {
        const response = await request;
        if (generation !== dashboardGeneration) return;
        if (response.ok) acceptCommunications(response.result);
    } finally {
        if (communicationsRequest === request) communicationsRequest = null;
    }
}

/* ---- account: category rates strip ------------------------------------ */

function renderAccountExtras() {
    const strip = $('#ratesStrip');
    if (!strip) return;
    const profile = (dashboardData && dashboardData.profile) || {};
    const rates = (dashboardData && dashboardData.category_rates_microusd_per_hour) || {};
    const entries = Object.entries(rates)
        .filter(([key, val]) => !RATE_EXCLUDED.has(key) && Number(val) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]));
    const show = Boolean(dashboardData) && Boolean(profile.category_pay_enabled)
        && (profile.credit_rate_override_microusd_per_hour == null)
        && entries.length > 0;
    strip.hidden = !show;
    if (!show) return;
    $('#ratesGrid').innerHTML = entries.map(([key, micro]) => {
        const tok = categoryToken(key);
        const label = escapeHtml(categoryLabel(key));
        return `<div class="rate-tile"><span class="dot" style="background: var(${tok});"></span>` +
            `<div class="rt-copy"><span class="name">${label}</span>` +
            `<span class="amt">${escapeHtml(formatMicroUsd(micro))}<span class="per">/hr</span></span></div></div>`;
    }).join('');
}

/* ---- payouts view ------------------------------------------------------ */

function renderPayouts() {
    if (bundleErrorCode) { renderPayoutsError(); return; }
    if (!dashboardData) { renderPayoutsLoading(); return; }

    const summary = dashboardData.summary || {};
    const cap = summary.earnings_cap_microusd;      // nullable = unlimited
    const earned = Number(summary.recording_earned_microusd) || 0;
    const available = Number(summary.available_balance_microusd) || 0;
    const held = Number(summary.held_balance_microusd) || 0;
    const paid = Number(summary.paid_balance_microusd) || 0;
    const capHit = (cap != null) && earned >= Number(cap);

    const balanceValue = $('#balanceValue');
    balanceValue.textContent = formatMicroUsd(available);
    // green only when there is actually money to take out — a green ₹0.00 lies
    balanceValue.className = available > 0 ? 'sum-value good' : 'sum-value';
    $('#balCapTag').hidden = !capHit;
    $('#hoursValue').innerHTML = durationParts(summary.active_duration_ms)
        .map(([v, u]) => `${escapeHtml(v)}<span class="unit">${u}</span>`).join(' ');
    $('#paidValue').textContent = formatMicroUsd(paid);

    const capPanel = $('#capPanel');
    if (cap == null) {
        capPanel.hidden = true;
    } else {
        capPanel.hidden = false;
        const capNum = Number(cap) || 0;
        const pct = capNum > 0 ? Math.round((earned / capNum) * 100) : 0;
        const fillPct = Math.min(100, Math.max(0, pct));
        $('#capNums').innerHTML = `${escapeHtml(formatMicroUsd(earned))} of ${escapeHtml(formatMicroUsd(capNum))}` +
            `<span class="pct">${pct}%</span>`;
        const fill = $('#capFill');
        fill.style.width = fillPct + '%';
        fill.className = capHit ? 'cap-fill bad' : (pct >= 90 ? 'cap-fill warn' : 'cap-fill');
        $('#capAlert').hidden = !capHit;
    }

    $('#payStats').innerHTML = `Earned <b>${escapeHtml(formatMicroUsd(earned))}</b>` +
        (held > 0 ? ` · <span class="proc">Processing ${escapeHtml(formatMicroUsd(held))}</span>` : '') +
        ` · Paid <b>${escapeHtml(formatMicroUsd(paid))}</b>`;

    // head sub-copy tracks the enabled method set
    const methods = payoutMethods();
    $('#paySub').textContent = methods.length > 1 ? 'Request a payout.'
        : PAY_SUB_COPY[methods[0].method] || 'Request a payout.';

    renderPayBody();
}

function payStatusHTML(active) {
    const label = active.status === 'pending_review' ? 'pending review'
        : active.status === 'approved' ? 'approved'
            : active.status === 'processing' ? 'processing'
                : escapeHtml(active.status || 'processing');
    const msg = (dashboardData && dashboardData.payout_message) || '';
    const amount = formatMicroUsd(active.requested_amount_microusd);
    const dest = isAccountEmailRequest(active)
        ? 'as a gift card'
        : `to ${escapeHtml(active.destination || '')}`;
    return `<div class="pay-status">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
        <div class="ps-copy">
            <strong>Payout request ${label}</strong>
            <span class="msg">${escapeHtml(msg)}</span>
        </div>
        <span class="dest">${escapeHtml(amount)} ${dest}</span>
    </div>`;
}

/* Result / rejection strip above the form: this session's instant outcome
   (sent / gift claim / failure) wins, else the last request's rejection or
   its still-claimable gift card. One strip at a time, each dismissible;
   a payout's statuses are terminal-exclusive, so one dismissed id covers
   every banner kind. */
function payFlashHTML(last) {
    const dismiss = '<button class="b-x" id="payAlertX" type="button" aria-label="Dismiss"></button>';
    if (instantResult) {
        if (instantResult.kind === 'error') {
            return `<div class="flash bad"><p>${escapeHtml(instantResult.message)}</p>${dismiss}</div>`;
        }
        if (instantResult.kind === 'gift') {
            return `<div class="flash good"><p>Your gift card is ready. ${claimLinkHTML(instantResult.claimUrl)}</p>${dismiss}</div>`;
        }
        // A paid gift card can arrive without a usable claim link (it still
        // goes out by email) — never render a "paid to" with no destination.
        const paidTo = instantResult.destination
            ? `paid to <span class="mono">${escapeHtml(instantResult.destination)}</span>`
            : 'paid out as a gift card';
        return `<div class="flash good"><p>Payout sent! ${escapeHtml(formatMicroUsd(instantResult.amountMicrousd))} ${paidTo}.</p>${dismiss}</div>`;
    }
    if (last && last.status === 'rejected' && last.id !== dismissedFlashId) {
        const reason = last.failure_reason || 'Your last request was rejected.';
        return `<div class="flash bad"><p>Last request rejected: ${escapeHtml(reason)} You can submit a new request.</p>${dismiss}</div>`;
    }
    const claimUrl = (last && last.status === 'paid' && last.id !== dismissedFlashId)
        ? safeClaimUrl(last.claim_url) : null;
    if (claimUrl) {
        return `<div class="flash good"><p>Your last payout was sent as a gift card. ${claimLinkHTML(claimUrl)}</p>${dismiss}</div>`;
    }
    return '';
}

function dismissPayFlash(last) {
    if (instantResult) {
        // Keyed by payout id so a dismissed outcome can't resurface as the
        // last-request banner once the refetched bundle carries it.
        if (instantResult.payoutId) dismissedFlashId = instantResult.payoutId;
        instantResult = null;
    } else if (last) {
        dismissedFlashId = last.id;
    }
    renderPayBody();
}

/* Compact segmented method toggle — first cell of the form row itself, so
   choosing a method reads as choosing what the destination field means.
   ⚡ marks an instant route (tooltip on hover). */
function methodSegHTML(methods, selected) {
    if (methods.length < 2) return '';
    const buttons = methods.map((m) => {
        const active = m.method === selected.method;
        const zap = m.route === 'instant' ? `<span class="zap-wrap" data-tip="Instant">${ZAP_SVG}</span>` : '';
        return `<button type="button" role="radio" aria-checked="${active}" class="${active ? 'active' : ''}"` +
            ` data-method="${escapeAttr(m.method)}">${escapeHtml(m.label)}${zap}</button>`;
    }).join('');
    return `<div class="method-seg" role="radiogroup" aria-label="Payout method">${buttons}</div>`;
}

/* One form strip for every method: [seg] [destination] [request]. UPI edits
   its destination; a gift card's is fixed — same field, non-editable. */
function renderPayBody() {
    const body = $('#payBody');
    const summary = dashboardData.summary || {};
    const profile = dashboardData.profile || {};
    const active = dashboardData.active_payout_request;
    const last = dashboardData.last_payout_request;
    const inFlight = active && ['pending_review', 'approved', 'processing'].includes(active.status);

    if (profile.status === 'banned') {
        body.innerHTML = `<div class="flash bad"><p>Your account is suspended. Payouts are paused. Your recording history stays available.</p></div>`;
        return;
    }
    if (inFlight) {
        body.innerHTML = payStatusHTML(active);
        return;
    }

    const methods = payoutMethods();
    const method = selectedPayoutMethod(methods);
    const gift = isAccountEmailMethod(method);
    const minPayout = Number(summary.minimum_payout_microusd) || 0;
    const available = Number(summary.available_balance_microusd) || 0;
    const canRequest = available >= minPayout && available > 0;

    let destField;
    if (gift) {
        const products = Array.isArray(method.products)
            ? method.products.filter((p) => typeof p === 'string' && p) : [];
        const brandsLabel = products.length === 1 ? '1 brand' : `${products.length} brands`;
        const brands = products.length
            ? `<button class="brands-tip" id="brandsTip" type="button" data-tip="${escapeAttr(products.join(' · '))}">${brandsLabel}</button>`
            : '';
        destField = `<span class="d-input dest-fixed">${MAIL_SVG}<span class="mono">${escapeHtml(accountEmail())}</span>${brands}</span>`;
    } else {
        // The typed value outlives the input node (a method toggle destroys it).
        const existingInput = $('#upiInline');
        const typed = existingInput ? existingInput.value : typedDestination;
        const lastDest = (last && last.method === method.method && last.destination) ? last.destination : '';
        destField = `<input class="d-input" id="upiInline" type="text" value="${escapeAttr(typed || lastDest)}" placeholder="UPI ID (e.g. name@okaxis)" spellcheck="false" autocomplete="off" />`;
    }

    const seg = methodSegHTML(methods, method);
    let html = payFlashHTML(last);
    html += `<div class="pay-form${seg ? ' with-seg' : ''}">${seg}${destField}
            <button class="btn-primary" id="btnRequestPayout" type="button"${canRequest ? '' : ' disabled'}>Request payout</button>
        </div>`;
    if (!gift) {
        html += `<p class="field-err" id="upiInlineErr" hidden>Invalid UPI ID format.</p>`;
    }
    if (!canRequest) {
        html += `<p class="pay-note">Minimum payout is ${escapeHtml(formatMicroUsd(minPayout))}.</p>`;
    }
    body.innerHTML = html;

    $$('.method-seg button', body).forEach((button) => button.addEventListener('click', () => {
        if (button.dataset.method === method.method) return;
        selectedMethodKey = button.dataset.method;
        renderPayBody();
    }));
    const brandsTip = $('#brandsTip');
    if (brandsTip) brandsTip.addEventListener('click', () => brandsTip.classList.toggle('open'));
    const btn = $('#btnRequestPayout');
    if (btn) btn.addEventListener('click', onRequestPayoutClick);
    const inp = $('#upiInline');
    if (inp) inp.addEventListener('input', () => {
        typedDestination = inp.value;
        inp.classList.remove('err');
        $('#upiInlineErr').hidden = true;
    });
    const ax = $('#payAlertX');
    if (ax) ax.addEventListener('click', () => dismissPayFlash(last));
    bindExternalLinks(body);
}

function onRequestPayoutClick() {
    const method = selectedPayoutMethod(payoutMethods());
    if (isAccountEmailMethod(method)) {
        openPayoutConfirm(method, null);
        return;
    }
    const input = $('#upiInline');
    if (!input) return;
    const value = input.value.trim();
    const ok = destinationRegexFor(method).test(value);
    input.classList.toggle('err', !ok);
    $('#upiInlineErr').hidden = ok;
    if (ok) openPayoutConfirm(method, value);
}

function openPayoutConfirm(method, destination) {
    payoutConfirm = { method, destination };
    const gift = isAccountEmailMethod(method);
    const available = (dashboardData && dashboardData.summary && dashboardData.summary.available_balance_microusd) || 0;
    $('#dlgEyebrow').textContent = `${method.label} payout`;
    $('#dlgConfirmAmount').textContent = formatMicroUsd(available);
    $('#dlgConfirmTo').textContent = gift ? 'as a gift card to' : 'to';
    $('#dlgConfirmUpi').textContent = gift ? accountEmail() : destination;
    $('#dlgWarnCopy').textContent = gift
        ? "This can't be undone. The claim link is emailed to you and stays available in Transactions."
        : "This can't be undone. A wrong UPI ID means a lost payout.";
    $('#dlgConfirmErr').hidden = true;
    $('#dlgConfirmErr').textContent = '';
    $('#btnPayConfirm').disabled = false;
    $('#btnPayConfirm').textContent = payoutConfirmLabel(method, false);
    setDesignState('payout_dialog');
    $('#payoutScrim').hidden = false;
}

function payoutConfirmLabel(method, busy) {
    if (method.route === 'instant') return busy ? 'Sending...' : 'Confirm & send';
    return busy ? 'Submitting...' : 'Confirm payout';
}

function closePayoutDialog() {
    $('#payoutScrim').hidden = true;
    communications.check();
    payoutConfirm = null;
    if (dashboardData) setDesignState('runtime_dashboard');
}

/* Adjustable rejections keep the dialog open for another try; every other
   error either has a dedicated path or an UNKNOWN outcome — the request may
   have gone through, so never invite a blind resubmit (close and refetch). */
const PAYOUT_ADJUSTABLE_CODES = new Set(['invalid_wallet', 'invalid_destination', 'below_minimum']);

async function submitPayout() {
    if (payoutSubmitting || !payoutConfirm) return;
    payoutSubmitting = true;
    const { method, destination } = payoutConfirm;
    const confirmBtn = $('#btnPayConfirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = payoutConfirmLabel(method, true);
    const params = { method: method.method };
    if (destination != null) params.destination = destination;
    const res = await callData('request_payout', params);
    payoutSubmitting = false;

    if (res.ok) {
        // A manual route lands in the pending status box on refetch; an
        // instant route settled server-side — flash the outcome immediately.
        const result = res.result || {};
        const claimUrl = safeClaimUrl(result.claim_url);
        instantResult = null;   // this outcome supersedes any earlier flash
        if (result.status === 'failed') {
            instantResult = {
                kind: 'error',
                payoutId: result.payout_id,
                message: `Payout failed: ${result.failure_reason || 'the destination could not be paid. Try again or contact support.'}`,
            };
        } else if (result.status === 'paid' && claimUrl) {
            instantResult = { kind: 'gift', payoutId: result.payout_id, claimUrl };
        } else if (result.status === 'paid') {
            instantResult = {
                kind: 'sent',
                payoutId: result.payout_id,
                amountMicrousd: result.requested_amount_microusd,
                destination: destination || '',
            };
        }
        typedDestination = '';
        closePayoutDialog();
        renderPayBody();
        await loadDashboard(true);
        return;
    }

    const code = res.error && res.error.code;
    if (code === 'update_required') { closePayoutDialog(); return; }
    if (code === 'account_suspended' || code === 'duplicate_request') {
        closePayoutDialog();
        await loadDashboard(true);
        return;
    }
    if (code === 'method_disabled') {
        // the served method set changed under us — surface it, re-pull the registry
        instantResult = { kind: 'error', message: errorCopy(res.error, 'That payout could not be submitted.') };
        closePayoutDialog();
        renderPayBody();
        await loadDashboard(true);
        return;
    }
    if (code && PAYOUT_ADJUSTABLE_CODES.has(code)) {
        // A destination rejection on a fixed-email method can't be fixed by
        // retyping — show the neutral destination copy, not the UPI copy.
        const copyCode = (code === 'invalid_wallet' && isAccountEmailMethod(method)) ? 'invalid_destination' : code;
        $('#dlgConfirmErr').textContent = errorCopy({ code: copyCode }, 'That payout could not be submitted.');
        $('#dlgConfirmErr').hidden = false;
        confirmBtn.disabled = false;
        confirmBtn.textContent = payoutConfirmLabel(method, false);
        return;
    }
    // no code (bridge deadline), cancelled, timeout, 5xx — outcome unknown;
    // the payout may exist or even be paid, so refetch instead of retrying.
    // Carry the notice through instantResult so it survives the refetch render
    // (and yields to the pending status box if the request actually landed).
    instantResult = { kind: 'error', message: 'Payout status unknown. Check your status below before retrying.' };
    closePayoutDialog();
    renderPayBody();
    await loadDashboard(true);
}

function renderPayoutsLoading() {
    setDesignState('earnings_loading');
    $('#balanceValue').textContent = '—';
    $('#balanceValue').className = 'sum-value';
    $('#hoursValue').textContent = '—';
    $('#paidValue').textContent = '—';
    $('#balCapTag').hidden = true;
    $('#capPanel').hidden = true;
    $('#payStats').textContent = '';
    $('#payBody').innerHTML = `<p class="pay-note">Loading your payout details…</p>`;
}

function renderPayoutsError() {
    setDesignState('earnings_error');
    $('#balanceValue').textContent = '—';
    $('#balanceValue').className = 'sum-value';
    $('#hoursValue').textContent = '—';
    $('#paidValue').textContent = '—';
    $('#capPanel').hidden = true;
    $('#payStats').textContent = '';
    $('#payBody').innerHTML = `<div class="flash bad"><p>${escapeHtml(errorCopy({ code: bundleErrorCode }, "We couldn't load your payouts."))}</p>` +
        `<button class="btn sm" id="btnRetryBundle" type="button">Retry</button></div>`;
    const retry = $('#btnRetryBundle');
    if (retry) retry.addEventListener('click', () => {
        bundleErrorCode = null;
        renderPayoutsLoading();
        loadDashboard(true);
    });
}

/* ---- history: recordings + ledger ------------------------------------- */

const REC_HEAD = `<div class="tbl-head g-rec"><span></span><span>Started</span><span>Status</span><span class="r">Active</span></div>`;
const LED_HEAD = `<div class="tbl-head g-ledger"><span>Date</span><span>Type</span><span class="r">Amount</span></div>`;
const CLIP_HEAD = `<div class="clip-head g-clip"><span>#</span><span class="r">Duration</span><span class="r">Idle</span><span class="r">Active</span><span>Category</span><span class="r">Rate</span><span class="r">Earned</span></div>`;

const PILL_CLASS = { Uploaded: 'neutral', Pending: 'warn', Paid: 'good', Processing: 'neutral', Rejected: 'bad', Failed: 'bad' };
function statusPillHTML(st, small) {
    return `<span class="pill ${small ? 'sm ' : ''}${PILL_CLASS[st] || 'neutral'}">${escapeHtml(st)}</span>`;
}

const CLIP_STATUS_META = {
    pending_upload: { label: 'Pending upload', kind: 'inflight' },
    processing: { label: 'Classifying', kind: 'inflight' },
    invalid_media: { label: 'Invalid clip', kind: 'terminal' },
    cap_reached: { label: 'Cap reached', kind: 'terminal' },
    not_eligible: { label: 'Not eligible', kind: 'terminal' },
    no_active_time: { label: 'No active time', kind: 'terminal' },
};

const LEDGER_TYPE_LABEL = {
    segment_credit: 'Credit', payout_sent: 'Paid Out',
    manual_adjustment: 'Adjustment', referral_bonus: 'Referral Bonus',
};

function cacheSet(cache, key, value) {
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

async function ensureHistoryPage() {
    const st = histState[histTab];
    const cache = histTab === 'recordings' ? recordingsCache : ledgerCache;
    if (cache.has(st.offset)) { st.page = cache.get(st.offset); renderHistory(); return; }
    renderHistoryLoading();
    const method = histTab === 'recordings' ? 'list_recordings' : 'list_ledger';
    const res = await callData(method, { offset: st.offset });
    if (res.ok && res.result) {
        cacheSet(cache, st.offset, res.result);
        st.page = res.result;
        renderHistory();
        managePoll();
    } else {
        const code = res.error && res.error.code;
        if (code === 'update_required') return;
        renderHistoryError(res.error);
    }
}

async function refreshRecordingsPage() {
    const st = histState.recordings;
    if (!st.page) return;
    const res = await callData('list_recordings', { offset: st.offset });
    if (res.ok && res.result) {
        cacheSet(recordingsCache, st.offset, res.result);
        st.page = res.result;
        if (histTab === 'recordings') renderHistory();
        managePoll();
    }
}

function renderHistory() {
    const list = $('#histList');
    const page = histState[histTab].page;
    if (!page) { renderHistoryLoading(); return; }
    const rows = Array.isArray(page.rows) ? page.rows : [];
    if (histTab === 'recordings') {
        list.innerHTML = rows.length
            ? REC_HEAD + rows.map((s, i) => sessionRowHTML(s, i)).join('')
            : `<div class="hist-empty">No recordings yet.</div>`;
        wireSessionRows();
    } else {
        list.innerHTML = rows.length
            ? LED_HEAD + rows.map(ledgerRowHTML).join('')
            : `<div class="hist-empty">No transactions yet.</div>`;
        bindExternalLinks(list);
    }
    renderPager(page);
    $$('#histTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === histTab));
}

function renderPager(page) {
    const total = Number(page.total_count) || 0;
    const limit = Number(page.limit) || PAGE_SIZE;
    const offset = Number(page.offset) || 0;
    const pageCount = Math.max(1, Math.ceil(total / limit));
    const pageNo = Math.floor(offset / limit);
    $('#histPager').style.visibility = pageCount > 1 ? 'visible' : 'hidden';
    $('#pagerLabel').textContent = `${String(pageNo + 1).padStart(2, '0')} / ${String(pageCount).padStart(2, '0')}`;
    $('#pagerPrev').disabled = pageNo === 0;
    $('#pagerNext').disabled = pageNo >= pageCount - 1;
}

function sessionRowHTML(s, i) {
    const sessionId = s.id;
    const open = openSessions.has(sessionId);
    const date = formatSessionDate(s.client_started_at || s.created_at);
    const sessStatus = s.status === 'pending_upload' ? 'Pending' : 'Uploaded';
    const active = fmtDuration(s.active_duration_ms);
    const body = open ? sessionClipsHTML(sessionId) : '';
    return `<div class="sess-row ${open ? 'open' : ''}" data-session-id="${escapeAttr(sessionId)}">
        <button class="g-rec" type="button" aria-expanded="${open}">
            <svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"></path></svg>
            <span class="s-date">${escapeHtml(date)}</span>
            ${statusPillHTML(sessStatus, true)}
            <span class="s-dur">${escapeHtml(active)}</span>
        </button>
        ${body}
    </div>`;
}

function sessionClipsHTML(sessionId) {
    const segs = segmentsCache.get(sessionId);
    if (segs === undefined) {
        return `<div class="clip-rows">${CLIP_HEAD}<div class="hist-empty">Loading clips…</div></div>`;
    }
    if (!Array.isArray(segs)) {
        return `<div class="clip-rows"><div class="hist-empty">Couldn't load clips.</div></div>`;
    }
    if (!segs.length) {
        return `<div class="clip-rows"><div class="hist-empty">No clips in this session.</div></div>`;
    }
    // Newest clip first: sort a copy descending by segment_index (the batch RPC
    // returns ascending). Matches web ExpandableSessionRow, so "Show all"
    // truncation hides the OLDEST clips, keeping in-flight rows visible.
    const ordered = [...segs].sort((a, b) => (Number(b.segment_index) || 0) - (Number(a.segment_index) || 0));
    const total = ordered.length;
    const showAll = showAllSessions.has(sessionId);
    const visible = showAll ? ordered : ordered.slice(0, CLIPS_VISIBLE);
    const hiddenCount = total - CLIPS_VISIBLE;
    const rows = visible.map((seg, i) => clipRowHTML(seg, i, total)).join('');
    const more = (!showAll && hiddenCount > 0)
        ? `<button class="show-all" type="button" data-session-id="${escapeAttr(sessionId)}">Show all ${total} clips <span class="dim">(${hiddenCount} more)</span></button>`
        : '';
    let durSum = 0, idleSum = 0, activeSum = 0, amtSum = 0;
    ordered.forEach((seg) => {
        durSum += Number(seg.claimed_duration_ms) || 0;
        idleSum += Number(seg.idle_duration_ms) || 0;
        activeSum += Number(seg.active_duration_ms) || 0;
        amtSum += Number(seg.credited_amount_microusd) || 0;
    });
    const totalRow = `<div class="clip-total g-clip">
        <span class="lbl">Total</span>
        <span class="r">${escapeHtml(fmtDuration(durSum))}</span>
        <span class="r">${escapeHtml(fmtDuration(idleSum))}</span>
        <span class="r">${escapeHtml(fmtDuration(activeSum))}</span>
        <span></span>
        <span></span>
        <span class="r">${escapeHtml(formatMicroUsd(amtSum))}</span>
    </div>`;
    return `<div class="clip-rows">${CLIP_HEAD}${rows}${more}${totalRow}</div>`;
}

function clipRowHTML(seg, i, total) {
    // Show the real segment index (web parity), not a running counter.
    const idx = String(seg.segment_index ?? 0).padStart(2, '0');
    const status = seg.clip_status;
    const dur = fmtDuration(seg.claimed_duration_ms);
    const idle = fmtDuration(seg.idle_duration_ms);
    const active = fmtDuration(seg.active_duration_ms);
    let catCell, rateCell, amtCell;
    if (status === 'earned') {
        catCell = catChipHTML(seg.clip_category);   // null → "—"
        const rate = seg.credited_rate_microusd_per_hour;
        rateCell = (rate != null)
            ? `<span class="c-rate">${escapeHtml(formatMicroUsd(rate))}/hr</span>`
            : `<span class="c-rate">—</span>`;
        amtCell = `<span class="c-amt">${escapeHtml(formatMicroUsd(seg.credited_amount_microusd ?? 0))}</span>`;
    } else {
        const meta = CLIP_STATUS_META[status] || { label: status || 'Unknown', kind: 'terminal' };
        catCell = `<span class="c-state ${meta.kind}"><span class="dot"></span>${escapeHtml(meta.label)}</span>`;
        if (meta.kind === 'inflight') {
            rateCell = `<span class="skel-cell" style="margin-left:auto;"></span>`;
            amtCell = `<span class="skel-cell" style="margin-left:auto;"></span>`;
        } else {
            rateCell = `<span class="c-rate">—</span>`;
            amtCell = `<span class="c-amt zero">${escapeHtml(formatMicroUsd(0))}</span>`;
        }
    }
    return `<div class="clip-row g-clip">
        <span class="c-idx">${idx}</span>
        <span class="c-dur">${escapeHtml(dur)}</span>
        <span class="c-dur">${escapeHtml(idle)}</span>
        <span class="c-dur">${escapeHtml(active)}</span>
        ${catCell}
        ${rateCell}
        ${amtCell}
    </div>`;
}

/* Paid Out rows carry their payout method: a gift card is a live claim link
   (↗ opens claim_url); UPI gets a quiet method tag for symmetry so mixed
   histories stay scannable. Canonical Type pill is untouched. */
function ledgerMethodHTML(e) {
    if (e.entry_type !== 'payout_sent') return '';
    const label = e.payout_method_label || e.payout_method;
    if (!label) return '';
    const claimUrl = safeClaimUrl(e.claim_url);
    if (claimUrl) {
        return `<a class="pill sm neutral claim" href="${escapeAttr(claimUrl)}" data-external-link>${escapeHtml(label)}${ARROW_NE_SVG}</a>`;
    }
    return `<span class="pill sm neutral">${escapeHtml(label)}</span>`;
}

function ledgerRowHTML(e) {
    const micro = Number(e.amount_microusd) || 0;
    const type = e.entry_type;
    const label = LEDGER_TYPE_LABEL[type] || (type ? String(type) : 'Entry');
    let negative;
    if (type === 'payout_sent') negative = true;              // stored positive, rendered as an outflow
    else if (type === 'manual_adjustment') negative = micro < 0;
    else negative = micro < 0;                               // credits / referral bonuses are positive
    const cls = negative ? 'minus' : 'plus';
    const sign = negative ? '−' : '+';
    const date = formatSessionDate(e.created_at || e.date);
    return `<div class="ledger-row g-ledger">
        <span class="l-date">${escapeHtml(date)}</span>
        <span class="l-type"><span class="pill sm neutral">${escapeHtml(label)}</span>${ledgerMethodHTML(e)}</span>
        <span class="l-amt ${cls}">${sign}${escapeHtml(formatMicroUsd(Math.abs(micro)))}</span>
    </div>`;
}

function wireSessionRows() {
    const list = $('#histList');
    $$('.sess-row > button', list).forEach((btn) => {
        btn.addEventListener('click', () => {
            const sessionId = btn.parentElement.dataset.sessionId;
            const wasOpen = openSessions.has(sessionId);
            openSessions.clear();       // accordion: one session open at a time
            showAllSessions.clear();
            if (!wasOpen) {
                openSessions.add(sessionId);
                if (!segmentsCache.has(sessionId)) loadSessionSegments(sessionId);
            }
            renderHistory();
            managePoll();
        });
    });
    $$('.show-all', list).forEach((b) => {
        b.addEventListener('click', (event) => {
            event.stopPropagation();
            showAllSessions.add(b.dataset.sessionId);
            renderHistory();
        });
    });
}

async function loadSessionSegments(sessionId) {
    const res = await callData('get_session_segments', { session_id: sessionId });
    if (res.ok && res.result) {
        segmentsCache.set(sessionId, Array.isArray(res.result[sessionId]) ? res.result[sessionId] : []);
        boundSegmentsCache();
        if (openSessions.has(sessionId)) renderHistory();
        managePoll();
    } else {
        const code = res.error && res.error.code;
        if (code === 'update_required') return;
        segmentsCache.set(sessionId, { __error: true });
        if (openSessions.has(sessionId)) renderHistory();
    }
}

function boundSegmentsCache() {
    while (segmentsCache.size > CACHE_LIMIT + 2) {
        const oldest = segmentsCache.keys().next().value;
        segmentsCache.delete(oldest);
    }
}

function reloadOpenSessions() {
    openSessions.forEach((sessionId) => loadSessionSegments(sessionId));
}

function gotoPage(delta) {
    const page = histState[histTab].page;
    if (!page) return;
    const limit = Number(page.limit) || PAGE_SIZE;
    const total = Number(page.total_count) || 0;
    const pageCount = Math.max(1, Math.ceil(total / limit));
    const pageNo = Math.floor((Number(page.offset) || 0) / limit);
    const nextNo = pageNo + delta;
    if (nextNo < 0 || nextNo >= pageCount) return;
    histState[histTab].offset = nextNo * limit;
    openSessions.clear();
    showAllSessions.clear();
    ensureHistoryPage();
}

function renderHistoryLoading() {
    $('#histList').innerHTML = `<div class="hist-empty">Loading…</div>`;
    $('#histPager').style.visibility = 'hidden';
}

function renderHistoryError(err) {
    $('#histList').innerHTML = `<div class="hist-empty">${escapeHtml(errorCopy(err, "Couldn't load history."))} ` +
        `<button class="btn sm" id="btnRetryHist" type="button">Retry</button></div>`;
    const retry = $('#btnRetryHist');
    if (retry) retry.addEventListener('click', ensureHistoryPage);
    $('#histPager').style.visibility = 'hidden';
}

/* ---- referrals view ---------------------------------------------------- */

function updateTabVisibility() {
    const tab = $('#referralsTab');
    if (!tab) return;
    const disabled = referralData && referralData.enabled === false;
    tab.style.display = disabled ? 'none' : '';
    if (disabled && currentView === 'referrals') setView('account');
}

function fmtThreshold(ms) {
    // floor, not round: the credit gate is exact-ms, so a pending referral
    // must never display "1hr / 1hr" before it actually crosses the threshold
    const m = Math.floor((Number(ms) || 0) / 60000);
    if (m >= 60 && m % 60 === 0) return `${m / 60}hr`;
    return `${m}m`;
}

function crestHTML(name) {
    const key = String(name || '?');
    const initial = (key[0] || '?').toUpperCase();
    const bg = crestColor(key);   // fixed palette hex — not injectable
    return `<span class="crest-sm" style="background: ${bg};" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

function referralRowHTML(r, defaultThrMs) {
    const name = r.referred_name || '—';
    let right;
    if (r.status === 'credited') {
        const t = fmtThreshold(r.threshold_ms || defaultThrMs);
        right = `<span class="r-status good">${escapeHtml(t)} / ${escapeHtml(t)}</span>`;
    } else if (r.status === 'pending' && (Number(r.referred_active_ms) || 0) > 0) {
        right = `<span class="r-status">${escapeHtml(fmtThreshold(r.referred_active_ms))} / ${escapeHtml(fmtThreshold(r.threshold_ms || defaultThrMs))}</span>`;
    } else {
        right = `<span class="r-status">Signed up</span>`;
    }
    return `<div class="ref-row">${crestHTML(name)}<span class="r-name">${escapeHtml(name)}</span>${right}</div>`;
}

function renderReferralInvitation() {
    const R = referralData;
    if (!R || R.enabled === false || referralErrorCode) return;
    const bonus = formatMicroUsd(R.effective_bonus_microusd).replace('.00', '');
    const thrMs = Number(R.effective_threshold_ms) || 0;
    const thrText = (thrMs === 3600000) ? 'hour' : `${Math.round(thrMs / 60000)} minutes`;
    $('#refTerms').textContent = `${bonus} for each friend who records their first ${thrText} of paid activity.`;

    const code = R.referral_code || '';
    const paused = communications.signupsEnabled() === false ||
        (communications.signupsEnabled() == null && R.signups_enabled === false);
    $('#btnCopyRef').disabled = paused || !code;
    $('#refLink').innerHTML = `<span class="dim">trykuro.app/r/</span>${escapeHtml(code)}`;

    const used = (Number(R.pending_count) || 0) + (Number(R.credited_count) || 0);
    const cap = R.effective_cap;
    const capPill = $('#refCapPill');
    if (cap == null) {
        capPill.hidden = true;
        $('#refLinkRow').hidden = false;
        $('#refCapNote').hidden = true;
    } else {
        const capNum = Number(cap) || 0;
        const capHit = used >= capNum;
        capPill.hidden = false;
        capPill.textContent = `${used} / ${capNum} used`;
        capPill.className = capHit ? 'cap-pill bad' : 'cap-pill';
        $('#refLinkRow').hidden = capHit;
        $('#refCapNote').hidden = !capHit;
    }

    if (paused) $('#refLinkRow').hidden = true;
}

function renderReferrals() {
    if (referralErrorCode) { renderReferralsError(); return; }
    if (!referralData) { renderReferralsLoading(); return; }
    const R = referralData;
    if (R.enabled === false) return;   // tab hidden

    renderReferralInvitation();
    const thrMs = Number(R.effective_threshold_ms) || 0;

    const people = Array.isArray(R.referrals) ? R.referrals : [];
    $('#refListLbl').textContent = `Referrals · ${people.length}`;
    $('#refEarnedMeta').textContent = `${formatMicroUsd(R.referral_earnings_microusd)} earned`;

    let html = people.map((r) => referralRowHTML(r, thrMs)).join('');
    if (R.referred_by_name) {
        html += `<div class="ref-row inviter">${crestHTML(R.referred_by_name)}` +
            `<span class="r-name">${escapeHtml(R.referred_by_name)}</span>` +
            `<span class="r-status">Invited you</span></div>`;
    }
    $('#refList').innerHTML = html;
}

function renderReferralsLoading() {
    setDesignState('referrals_loading');
    $('#refCapPill').hidden = true;
    $('#refEarnedMeta').textContent = '';
    $('#refTerms').textContent = '';
    $('#refList').innerHTML = `<div class="hist-empty">Loading referrals…</div>`;
}

function renderReferralsError() {
    setDesignState('referrals_error');
    $('#refList').innerHTML = `<div class="hist-empty">${escapeHtml(errorCopy({ code: referralErrorCode }, "Couldn't load referrals."))} ` +
        `<button class="btn sm" id="btnRetryRef" type="button">Retry</button></div>`;
    const retry = $('#btnRetryRef');
    if (retry) retry.addEventListener('click', () => {
        referralErrorCode = null;
        referralLoaded = false;
        renderReferralsLoading();
        loadReferral(true);
    });
}

/* ---- static dashboard bindings (elements always present in index.html) - */

const ratesToggle = $('#ratesToggle');
if (ratesToggle) ratesToggle.addEventListener('click', () => {
    const strip = $('#ratesStrip');
    const open = strip.classList.toggle('open');
    $('#ratesPanel').hidden = !open;
    ratesToggle.setAttribute('aria-expanded', String(open));
});

$$('#histTabs button').forEach((b) => b.addEventListener('click', () => {
    if (histTab === b.dataset.tab) return;
    histTab = b.dataset.tab;
    openSessions.clear();
    showAllSessions.clear();
    ensureHistoryPage();
}));
$('#pagerPrev').addEventListener('click', () => gotoPage(-1));
$('#pagerNext').addEventListener('click', () => gotoPage(1));

const copyBtn = $('#btnCopyRef');
if (copyBtn) copyBtn.addEventListener('click', () => {
    const code = (referralData && referralData.referral_code) || '';
    if (!code || copyBtn.disabled || communications.signupsEnabled() === false) return;
    const url = `https://trykuro.app/r/${code}`;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).catch(() => {});
        }
    } catch (e) { /* clipboard unavailable — ignore */ }
    copyBtn.textContent = 'Copied';
    copyBtn.classList.add('copied');
    window.setTimeout(() => { copyBtn.textContent = 'Copy link'; copyBtn.classList.remove('copied'); }, 1400);
});

$('#btnPayBack').addEventListener('click', closePayoutDialog);
$('#btnPayConfirm').addEventListener('click', submitPayout);
$('#payoutScrim').addEventListener('click', (event) => {
    if (event.target === $('#payoutScrim')) closePayoutDialog();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#payoutScrim').hidden) closePayoutDialog();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (isDashboardVisible()) { loadDashboard(); loadReferral(); loadCommunications(true); }
    } else {
        stopPoll();
    }
    managePoll();
});

window.addEventListener('focus', () => {
    if (isDashboardVisible()) loadCommunications(true);
});

boot();
