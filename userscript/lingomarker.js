// ==UserScript==
// @name         LingoMarker
// @namespace    http://tampermonkey.net/
// @version      0.11
// @description  Highlight and store selected words via LingoMarker backend
// @author       1token & AI Assistant
// @match        https://*.reuters.com/*
// @match        https://*.apnews.com/*
// @match        https://apnews.com/*
// @match        https://*.bbc.com/*
// @match        https://*.ft.com/*
// @match        https://*.thebulwark.com/*
// @match        https://*.npr.org/*
// @match        https://*.pbs.org/*
// @match        https://archive.ph/*
// @match        https://izboran.gitlab.io/*
// @match        https://*.theatlantic.com/*
// @match        https://*.nytimes.com/*
// @match        https://*.theguardian.com/*
// @match        https://*.standardebooks.org/*
// @match        https://standardebooks.org/*
// @match        https://*.musixmatch.com/*
// @match        https://*.sueddeutsche.de/*
// @match        https://*.faz.net/*
// @match        https://*.lemonde.fr/*
// @match        https://*.lingea.sk/*
// @match        https://www.lingomarker.com/review
// @match        https://www.lingomarker.com/podcasts/play/*
// @match        https://dev.lingomarker.com:8443/review*
// @match        https://dev.lingomarker.com:8443/podcasts/play/*
// @include      http://127.0.0.1:3000/*
// @connect      dev.lingomarker.com
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdnjs.cloudflare.com/ajax/libs/mark.js/8.11.1/mark.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js
// @run-at       document-body
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration ---
    const BACKEND_URL = 'https://dev.lingomarker.com:8443'; // Adjust port if needed
    // REMOVED: HIGHLIGHT_COLOR, WORDS_NUMBER_LIMIT, WORDS_LENGHT_LIMIT, DEFAULT_DICTIONARY_EN_SK, ALLOW_FRAGMENT_URL_LIST, dictBaseUrl

    const DEBOUNCE_TIME = 1000;
    const MAX_HIGHLIGHTS = 10000;
    const PAGE_SIZE_LIMIT = 1000000;

    // --- State ---
    let markInstance;
    let isHighlighting = false;
    let mutationObserverInstance = null;
    let lastTrigger = 0;
    let userData = { entries: [], urls: [], paragraphs: [], relations: [] };
    let isAuthenticated = false;
    let currentUser = null;

    // --- Dynamic Settings (initialized with defaults, fetched from backend) ---
    let highlightColor = 'rgba(210, 210, 10, 0.4)';
    let wordsNumberLimit = 4;
    let wordsLengthLimit = 50;
    let dictBaseUrl = 'https://slovniky.lingea.sk/anglicko-slovensky/'; // Default dictionary URL
    let allowFragmentUrlList = ['https://www.nytimes.com/', 'https://developer.mozilla.org/']; // Default list

    let isDialogActive = false; // Flag to track if dialog is currently shown
    const touchScreen = matchMedia('(hover: none), (pointer: coarse)').matches;

    // --- Initialization ---

    async function initialize() {
        console.log("LingoMarker Script Initializing...");
        // 1. Check Auth & Fetch Settings (Combined)
        await checkAuthAndFetchSettings(); // Renamed function

        if (!isAuthenticated) {
            console.warn("LingoMarker: User not authenticated. Features disabled.");
            // Optionally redirect to login or show a message
            // Check if we are NOT already on a login/register page
            if (!window.location.href.startsWith(BACKEND_URL + "/login") && !window.location.href.startsWith(BACKEND_URL + "/register")) {
                // Maybe show a non-intrusive notification instead of redirecting immediately
                console.log("Please log in to LingoMarker backend to use the script.");
                // showLoginPrompt(); // Implement this if needed
            }
            return; // Stop initialization if not logged in
        }

        console.log("LingoMarker: User authenticated:", currentUser);
        console.log("LingoMarker: Settings loaded:", { dictBaseUrl, highlightColor /* etc */ });

        // 2. Apply Styles (needs update for dynamic color)
        applyStyles(); // Call applyStyles AFTER settings are fetched

        // 3. Initialize Mark.js
        if (document.body.textContent.length > PAGE_SIZE_LIMIT) {
            console.warn('Page too large for highlighting');
            return;
        }
        markInstance = new Mark(document.body);

        // 4. Fetch User Data and Apply Initial Highlights
        await fetchUserDataAndHighlight(); // Already applies highlights

        // 5. Setup Event Listeners and Observers
        setupEventListeners();
        setupMutationObserver();

        // 6. Register Menu Commands
        registerMenuCommands();

        console.log("LingoMarker Script Initialized Successfully.");

    }

    function applyStyles() {
        // 1. Inject base styles with CSS custom property placeholder
        GM_addStyle(`
            :root { /* Define property on root */
                --lingomarker-highlight-bg: ${highlightColor}; /* Set initial/default value */
                --lingomarker-highlight-bg-hover: ${highlightColor.replace('0.4', '0.6')}; /* Calculate hover default too */
            }

            .lingomarker-highlight {
                background-color: var(--lingomarker-highlight-bg) !important; /* Use the variable */
                cursor: pointer;
                transition: background-color 0.2s;
                text-decoration: none;
                padding-bottom: 1px;
                border-bottom: 1px dotted currentColor;
            }
            .lingomarker-highlight:hover {
                background-color: var(--lingomarker-highlight-bg-hover) !important; /* Use hover variable */
            }
            /* ... rest of styles (.lingomarker-dialog, keyframes, etc.) ... */
            .lingomarker-dialog { /* Renamed class */
               animation: lingomarker-fadein 0.15s ease-out;
            }
            .lingomarker-dialog a:hover {
               text-decoration: underline !important;
            }
            @keyframes lingomarker-fadein {
               from { opacity: 0; transform: translateY(-4px); }
               to { opacity: 1; transform: translateY(0); }
            }
            #lingomarker-login-prompt { /* Style for potential login prompt */
                /* ... */
            }
            #lingomarker-login-prompt a { /* ... */ }
        `);

        // 2. Update the CSS custom property value (called after settings are fetched)
        updateHighlightColorStyle();
    }

    // New function to update the CSS variable
    function updateHighlightColorStyle() {
        const hoverColor = calculateHoverColor(highlightColor); // Helper to calculate hover variant
        document.documentElement.style.setProperty('--lingomarker-highlight-bg', highlightColor);
        document.documentElement.style.setProperty('--lingomarker-highlight-bg-hover', hoverColor);
    }

    // Helper function to calculate hover color (adjust opacity)
    function calculateHoverColor(baseColor) {
        try {
            // Basic RGBA opacity increase
            if (baseColor.startsWith('rgba(')) {
                const parts = baseColor.match(/[\d.]+/g);
                if (parts && parts.length === 4) {
                    const alpha = parseFloat(parts[3]);
                    const newAlpha = Math.min(1, alpha + 0.2); // Increase alpha by 0.2, max 1
                    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${newAlpha})`;
                }
            }
            // Basic HEX alpha increase (if browsers support #RRGGBBAA) - less common/reliable
            // Add more sophisticated color parsing/manipulation library if needed
            // Fallback: just return the base color slightly darker maybe?
            // For simplicity, just return a slightly modified default if calculation fails
            return baseColor.includes('rgba') ? baseColor.replace(/(\d\.\d+)\)/, (match, p1) => `${Math.min(1, parseFloat(p1) + 0.2)})`) : 'rgba(210, 210, 10, 0.6)';

        } catch (e) {
            console.warn("Could not calculate hover color, using default.", e);
            return 'rgba(210, 210, 10, 0.6)'; // Default hover
        }
    }

    function showLoginPrompt() {
        if (document.getElementById('lingomarker-login-prompt')) return; // Already showing

        const promptDiv = document.createElement('div');
        promptDiv.id = 'lingomarker-login-prompt';
        promptDiv.innerHTML = `LingoMarker: Please <a id="lingomarker-login-link">log in</a> to save words.`;
        document.body.appendChild(promptDiv);

        document.getElementById('lingomarker-login-link').addEventListener('click', () => {
            GM_openInTab(BACKEND_URL + '/login', { active: true });
            promptDiv.remove();
        });
    }


    // --- Authentication & API Calls ---

    function apiRequest(method, path, data = null) {
        return new Promise((resolve, reject) => {
            const details = {
                method: method,
                url: BACKEND_URL + path,
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                timeout: 20000, // 20 seconds
                withCredentials: true, // Crucial for sending session cookies
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            resolve(JSON.parse(response.responseText || '{}'));
                        } catch (e) {
                            console.error("Failed to parse JSON response:", response.responseText, e);
                            // If response is empty or not json, resolve with empty object for OK status
                            if (response.status === 200 || response.status === 204) {
                                resolve({});
                            } else {
                                reject(new Error("Failed to parse JSON response"));
                            }
                        }
                    } else if (response.status === 401) {
                        isAuthenticated = false;
                        currentUser = null;
                        console.warn(`LingoMarker: Unauthorized (${response.status}) accessing ${path}. Need login.`);
                        // Maybe clear highlights if user logs out elsewhere?
                        safeApplyHighlights(); // Re-apply (will likely clear highlights now)
                        showLoginPrompt();
                        reject(new Error(`Unauthorized (${response.status})`));
                    } else {
                        let errorMsg = `Request failed (${response.status})`;
                        try {
                            const errorData = JSON.parse(response.responseText);
                            if (errorData && errorData.error) {
                                errorMsg += ": " + errorData.error;
                            }
                        } catch (e) { /* Ignore parse error */ }
                        console.error(`LingoMarker API Error accessing ${path}:`, errorMsg, response.responseText);
                        reject(new Error(errorMsg));
                    }
                },
                onerror: function (error) {
                    console.error(`LingoMarker Network Error accessing ${path}:`, error);
                    reject(new Error("Network error or backend unreachable"));
                },
                ontimeout: function () {
                    console.error(`LingoMarker Timeout accessing ${path}`);
                    reject(new Error("Request timed out"));
                }
            };
            if (data) {
                details.data = JSON.stringify(data);
            }
            GM_xmlhttpRequest(details);
        });
    }

    // Rename and modify this function
    async function checkAuthAndFetchSettings() {
        try {
            const data = await apiRequest('GET', '/api/session');
            if (data.authenticated && data.settings) {
                isAuthenticated = true;
                currentUser = { // Store only necessary user info
                    userID: data.userID,
                    username: data.username,
                    name: data.name,
                };

                // --- Apply fetched settings ---
                const settings = data.settings;
                highlightColor = settings.highlightColor || highlightColor; // Use default if missing
                wordsNumberLimit = settings.wordsNumberLimit || wordsNumberLimit;
                wordsLengthLimit = settings.wordsLengthLimit || wordsLengthLimit;
                dictBaseUrl = settings.dictBaseUrl || dictBaseUrl;

                // Parse comma-separated list for allowFragmentUrlList
                if (settings.allowFragmentUrlList && typeof settings.allowFragmentUrlList === 'string') {
                    allowFragmentUrlList = settings.allowFragmentUrlList.split(',')
                        .map(url => url.trim())
                        .filter(url => url.length > 0); // Filter out empty strings
                } else {
                    // Use default if missing or invalid type
                    allowFragmentUrlList = ['https://www.nytimes.com/', 'https://developer.mozilla.org/'];
                }

                // --- End Apply fetched settings ---

                // Remove login prompt if it exists
                const promptDiv = document.getElementById('lingomarker-login-prompt');
                if (promptDiv) promptDiv.remove();

            } else {
                isAuthenticated = false;
                currentUser = null;
                // Reset settings to default if auth fails or settings missing? Optional.
            }
        } catch (error) {
            isAuthenticated = false;
            currentUser = null;
            // Error already logged in apiRequest
            // Reset settings to default on error?
            // highlightColor = 'rgba(210, 210, 10, 0.4)';
            // wordsNumberLimit = 4;
            // ... reset others ...
        }
    }

    async function fetchUserDataAndHighlight() {
        if (!isAuthenticated) return;
        try {
            console.log("Fetching user data...");
            const bundle = await apiRequest('GET', '/api/data');
            // Basic validation of bundle structure
            if (bundle && Array.isArray(bundle.entries) && Array.isArray(bundle.urls) && Array.isArray(bundle.paragraphs) && Array.isArray(bundle.relations)) {
                userData = bundle;
                console.log(`Fetched ${userData.entries.length} entries, ${userData.relations.length} relations.`);
                safeApplyHighlights(); // Apply highlights with fetched data
            } else {
                console.error("Invalid data structure received from /api/data:", bundle);
                userData = { entries: [], urls: [], paragraphs: [], relations: [] }; // Reset data
                safeApplyHighlights(); // Clear highlights
            }
        } catch (error) {
            console.error("Failed to fetch user data:", error);
            // Keep potentially stale data or clear it? Clear for safety.
            userData = { entries: [], urls: [], paragraphs: [], relations: [] };
            safeApplyHighlights(); // Clear highlights
        }
    }

    // --- Highlighting Logic ---

    function escapeRegex(str) {
        // Escape special characters for regex. Handles more cases than before.
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function getRegexFromUserData() {
        if (!userData || !userData.entries || userData.entries.length === 0) {
            return null; // No regex needed if no words
        }

        const allForms = new Set();
        userData.entries.forEach(entry => {
            if (entry.formsPipeSeparated) {
                entry.formsPipeSeparated.split('|').forEach(form => {
                    if (form) allForms.add(escapeRegex(form.trim()));
                });
            } else if (entry.word) {
                // Fallback if forms somehow missing, use base word
                allForms.add(escapeRegex(entry.word.trim()));
            }
        });

        if (allForms.size === 0) {
            return null;
        }

        // Create a regex pattern like \b(?:word1|formA|formB|word2|formC)\b
        // Sorting by length DESC *might* help performance by matching longer forms first,
        // preventing partial matches on shorter forms within longer ones.
        const sortedForms = Array.from(allForms).sort((a, b) => b.length - a.length);
        const pattern = `\\b(?:${sortedForms.join('|')})\\b`;

        return new RegExp(pattern, 'gi'); // Global, Case-insensitive
    }

    const safeApplyHighlights = _.debounce(async () => {
        if (isHighlighting || !markInstance) return;
        if (!isAuthenticated) { // Don't highlight if not logged in
            markInstance.unmark();
            return;
        }

        isHighlighting = true;

        if (mutationObserverInstance) {
            mutationObserverInstance.disconnect();
            // console.log('Observer disconnected for highlighting');
        }

        const regex = getRegexFromUserData();

        markInstance.unmark({
            exclude: ['span[data-immersive-translate-walked]'],
            done: () => {
                if (!regex) { // No words to highlight
                    isHighlighting = false;
                    observeMutations();
                    // console.log('No words, observer reconnected');
                    return;
                }

                // console.log("Applying highlights with regex:", regex);
                markInstance.markRegExp(regex, {
                    exclude: ['.lingomarker-dialog', 'script', 'style', 'noscript', 'textarea', 'input', 'select'],
                    element: 'span', // Use span instead of 'a' if not linking directly
                    className: 'lingomarker-highlight',
                    acrossElements: true,
                    separateWordSearch: false,
                    iframes: false,
                    each: async (node) => {
                        // Optional: Add click/hover listeners here if needed
                        // E.g., to show definition popup or update relation timestamp on click
                        node.addEventListener('click', handleHighlightClick);
                    },
                    done: () => {
                        // console.log('Marking done');
                        isHighlighting = false;
                        observeMutations();
                        // console.log('Observer reconnected after marking');
                    },
                    noMatch: (term) => {
                        // This is normal if the regex includes many forms not on the current page
                        // console.log('No match found for term component:', term);
                    },
                    filter: (textNode, markedTerm, totalCounter) => {
                        // Optional filter: e.g., ignore text within links already
                        // return textNode.parentNode.nodeName !== 'A';
                        // Filter out nodes within our own dialogs or highlights
                        let parent = textNode.parentNode;
                        while (parent && parent !== document.body) {
                            if (parent.classList && (parent.classList.contains('lingomarker-dialog') || parent.classList.contains('lingomarker-highlight'))) {
                                return false; // Don't highlight inside dialog or existing highlight
                            }
                            parent = parent.parentNode;
                        }
                        return true;
                    }
                });
            }
        });
    }, 300); // Adjust debounce time if needed

    function getTranscriptSegmentRef(node) {
        let transcriptSegmentRef = null;
        if (window.location.pathname.startsWith('/podcasts/play/')) {
            let elementForClosest = node; // Start with the node itself

            // If the node is a Text node, get its parentElement
            if (node.nodeType === Node.TEXT_NODE) {
                elementForClosest = node.parentElement;
            }

            // Now use elementForClosest (which is guaranteed to be an Element or null)
            if (elementForClosest) { // Check if elementForClosest is not null
                const segmentElement = elementForClosest.closest('.transcript-segment');
                if (segmentElement && segmentElement.dataset.timestamp) {
                    transcriptSegmentRef = segmentElement.dataset.timestamp;
                    console.log("Found segment ref:", transcriptSegmentRef);
                } else {
                    console.log("Could not find .transcript-segment or data-timestamp for node:", node, "elementForClosest:", elementForClosest);
                }
            } else {
                console.log("elementForClosest was null, cannot find .transcript-segment for node:", node);
            }
        } else if (window.location.pathname.startsWith('/review')) {
            let elementForClosest = node; // Start with the node itself

            // If the node is a Text node, get its parentElement
            if (node.nodeType === Node.TEXT_NODE) {
                elementForClosest = node.parentElement;
            }

            // Now use elementForClosest (which is guaranteed to be an Element or null)
            if (elementForClosest) { // Check if elementForClosest is not null
                const segmentElement = elementForClosest.parentElement.querySelector("a.goto-segment-icon");
                if (segmentElement && segmentElement.href && segmentElement.href.split('#')[1] && segmentElement.href.split('#')[1].split('=')[1]) {
                    transcriptSegmentRef = segmentElement.href.split('#')[1];
                    transcriptSegmentRef = decodeURIComponent(transcriptSegmentRef.split('=')[1]);
                    console.log("Found segment ref:", transcriptSegmentRef);
                } else {
                    console.log("Could not find .goto-segment-icon or data-timestamp for node:", node, "elementForClosest:", elementForClosest);
                }
            } else {
                console.log("elementForClosest was null, cannot find .goto-segment-icon for node:", node);
            }
        }
        return transcriptSegmentRef;
    }

    // Handle clicking on an *existing* highlight
    async function handleHighlightClick(event) {
        event.preventDefault();
        event.stopPropagation();

        if (!isAuthenticated) return;

        const node = event.target; // The highlighted span
        const clickedWord = node.textContent.trim().toLowerCase();

        // Find the matching entry in userData based on the clicked word form
        const entry = findEntryByWordForm(clickedWord);

        if (!entry) {
            console.warn("Clicked highlight, but couldn't find matching entry for:", clickedWord);
            return;
        }

        // Find context (URL, Paragraph) similar to handleSelection
        const context = await getContextFromNode(node);
        if (!context) {
            console.warn("Could not determine context for clicked highlight.");
            return;
        }

        const transcriptSegmentRef = getTranscriptSegmentRef(node);

        console.log(`Clicked existing highlight: Word='${clickedWord}', EntryUUID='${entry.uuid}', URL='${context.url}', ParagraphHash='${context.paragraphHash}', transcriptSegmentRef='${transcriptSegmentRef}`);

        try {
            // Send update to backend (essentially the same as marking it again)
            // This updates the 'updated_at' timestamp for the relation
            await apiRequest('POST', '/api/mark', {
                word: entry.word, // Send the base word
                entryUUID: entry.uuid, // Send existing UUID
                url: context.url,
                title: context.title,
                paragraphText: context.paragraphText,
                urlHash: context.urlHash,
                paragraphHash: context.paragraphHash,
                transcriptSegmentRef: transcriptSegmentRef,
            });
            console.log("Relation timestamp updated for:", entry.word);

            // Optional: Open dictionary link if still desired
            window.open(createDictionaryLink(entry.word), 'Lingea'); // Use base word
            // GM_openInTab(createDictionaryLink(entry.word), { active: false, setParent: true }); // Open in background

            // --- Alternative: Show a small info popup instead of opening dictionary ---
            // showInfoPopup(event, entry, context);

        } catch (error) {
            console.error("Failed to update relation timestamp:", error);
            // Show user feedback?
        }
    }

    function createDictionaryLink(word) {
        return `${dictBaseUrl}${encodeURI(word)}`;
    }

    function findEntryByWordForm(wordForm) {
        if (!userData || !userData.entries) return null;
        const lowerWordForm = wordForm.toLowerCase();
        for (const entry of userData.entries) {
            const forms = entry.formsPipeSeparated ? entry.formsPipeSeparated.toLowerCase().split('|') : [entry.word.toLowerCase()];
            if (forms.includes(lowerWordForm)) {
                return entry;
            }
        }
        return null;
    }


    // --- Selection Handling ---

    // --- Dialog Functions ---
    function showContextDialog(selection, caption, callback) {
        lastTrigger = Date.now();

        let dialog = document.querySelector('.lingomarker-dialog');

        if (dialog) {
            clearTimeout(dialog.dataset.timeoutId); // Clear timeout manually

            // --- Auto-close Timeout ---
            const timeoutId = setTimeout(() => {
                console.log("Dialog timed out.");
                closeDialogVisuals(dialog); // Close visuals only
                // ACTION: Reset flag, DO NOT clear selection.
                isDialogActive = false;
                /// document.removeEventListener('click', outsideClickListener, true); // Remove outside listener; can't do this here :-(
                // NOTE: window.getSelection().removeAllRanges(); // <<< REMOVED
            }, 5000);
            dialog.dataset.timeoutId = timeoutId; // Store ID to clear it
        } else {
            dialog = document.createElement('div');
            dialog.className = 'lingomarker-dialog notranslate';
            // Positioning & Styling (as before)
            const range = selection.getRangeAt(0).cloneRange();
            const rect = range.getBoundingClientRect();
            Object.assign(dialog.style, {
                position: 'absolute',
                left: `${rect.left + window.scrollX}px`,
                top: `${rect.bottom + window.scrollY + (touchScreen ? 28 : 5)}px`,
                zIndex: 9999999999999,
                background: 'white',
                backgroundColor: 'rgb(208, 180, 111)',
                padding: '5px 10px', // Smaller padding
                borderRadius: '4px',
                boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                fontSize: '14px', // Smaller font
                textAlign: 'center',
                cursor: 'pointer',
                border: '1px solid #aaa',
                padding: '8px 5px 8px 5px'
            });

            // --- Dialog Click (Confirmation) ---
            dialog.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Don't reset isDialogActive or clear selection here.
                closeDialogVisuals(dialog); // Close visuals only
                clearTimeout(dialog.dataset.timeoutId); // Clear timeout manually
                document.removeEventListener('click', outsideClickListener, true); // Remove outside listener
                if (callback) callback(); // Execute the marking logic (which handles state/selection)
            });

            if (mutationObserverInstance) mutationObserverInstance.disconnect();
            document.body.appendChild(dialog);

            // --- Auto-close Timeout ---
            const timeoutId = setTimeout(() => {
                console.log("Dialog timed out.");
                closeDialogVisuals(dialog); // Close visuals only
                // ACTION: Reset flag, DO NOT clear selection.
                isDialogActive = false;
                document.removeEventListener('click', outsideClickListener, true); // Remove outside listener
                // NOTE: window.getSelection().removeAllRanges(); // <<< REMOVED
            }, 5000);
            dialog.dataset.timeoutId = timeoutId; // Store ID to clear it

            // --- Close on Outside Click ---
            const outsideClickListener = (event) => {
                // Find the specific dialog instance this listener is for (safer if multiple could exist)
                const currentDialog = document.querySelector('.lingomarker-dialog'); // Simple assumption: only one dialog
                if (currentDialog && !currentDialog.contains(event.target)) {
                    console.log("Clicked outside dialog.");
                    clearTimeout(currentDialog.dataset.timeoutId); // Clear the timeout
                    closeDialogVisuals(currentDialog); // Close visuals only
                    // ACTION: Reset flag, DO NOT clear selection.
                    isDialogActive = false;
                    document.removeEventListener('click', outsideClickListener, true); // Clean up self
                    // NOTE: window.getSelection().removeAllRanges(); // <<< REMOVED
                }
            };
            // Store listener function itself for potential removal (though it removes itself now)
            dialog.dataset.outsideClickListener = outsideClickListener;

            setTimeout(() => { // Delay adding listener slightly
                document.addEventListener('click', outsideClickListener, true);
            }, 50);
        }

        dialog.textContent = `Mark "${caption}"`;

        observeMutations();
        return dialog;
    }

    // Renamed to clarify it only handles visuals + listener cleanup potentially
    function closeDialogVisuals(dialog) {
        if (dialog && dialog.parentNode) {
            dialog.remove();
            // Optional: try removing its specific listener if needed, but current design should handle it.
        }
    }

    async function sha256(message) {
        const msgBuffer = new TextEncoder().encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    function normalizeBackendUrl(url) {
        if (url.startsWith(BACKEND_URL)) {
            let relativeUrl = url.slice(BACKEND_URL.length);
            if (!relativeUrl.startsWith('/')) {
                relativeUrl = '/' + relativeUrl;
            }
            return relativeUrl;
        }
        return url;
    }

    function getUrlFromNode(node) {
        // Find the nearest parent A tag with an href, or use window.location
        let current = node;
        while (current && current !== document.body) {
            if (current.nodeName === 'H3' && current.className === 'review-source-title') {
                const child = current.firstChild;
                if (child.nodeName === 'A' && child.href && child.className === 'review-source-link') {
                    // Special handling for review page
                    return normalizeBackendUrl(child.href);
                }
            }
            if (current.nodeName === 'A' && current.href) {
                // Check if it's an internal page link
                if (current.href.startsWith(window.location.origin + '/#')) {
                    // Internal link, prefer window.location.href
                } else if (current.href.startsWith('http')) {
                    // Prefer the link's href if it's a full URL
                    return normalizeBackendUrl(current.href);
                }
            }
            if (current.nodeName === 'P' && current.className === 'review-paragraph') {
                current = current.previousElementSibling;
            } else {
                current = current.parentNode;
            }
        }

        // Fallback to window location
        return normalizeBackendUrl(window.location.href);
    }

    async function getContextFromNode(node) {
        try {
            let element = node.parentNode;

            // Traverse up to find a meaningful block element (P, DIV, ARTICLE, etc.)
            // Avoid stopping at inline elements like SPAN, A, B, I, etc.
            const inlineTags = new Set(['SPAN', 'A', 'B', 'I', 'EM', 'STRONG', 'MARK', 'SUB', 'SUP', 'CODE']);
            while (element && element !== document.body && (inlineTags.has(element.nodeName) || !element.textContent?.trim())) {
                element = element.parentNode;
            }
            // If we hit body or null, maybe take immediate parent?
            if (!element || element === document.body) {
                element = node.parentNode; // Fallback
            }

            // Remove immersive translate elements
            element.querySelectorAll('.immersive-translate-target-wrapper').forEach(e => e.remove());

            const paragraphText = element.innerText?.trim() || node.textContent?.trim() || ""; // Sanitize and fallback
            if (!paragraphText) {
                console.warn("Could not extract paragraph text.");
                return null;
            }

            const paragraphHash = await sha256(paragraphText);

            const nodeUrl = getUrlFromNode(node); // Use helper to get best URL
            const url = allowFragmentUrlList.some(prefix => nodeUrl.startsWith(prefix))
                ? nodeUrl // Keep fragment for allowed sites
                : nodeUrl.split('#')[0]; // Remove fragment otherwise

            const urlHash = await sha256(url);
            const urlFragment = nodeUrl.includes('#') ? nodeUrl.split('#')[1] : null;
            const titleText = (document.title || "").trim();
            const finalTitle = urlFragment ? `${titleText} #${urlFragment}` : titleText;

            return {
                paragraphText: paragraphText,
                paragraphHash: paragraphHash,
                url: url,
                urlHash: urlHash,
                title: finalTitle || null, // Ensure null if empty
            };
        } catch (e) {
            console.error("Error getting context:", e);
            return null;
        }
    }

    // --- Mutation Observer ---

    function setupMutationObserver() {
        mutationObserverInstance = new MutationObserver((mutations) => {
            // Basic check: Did *any* nodes get added or removed?
            // More complex checks could try to be smarter about *which* nodes.
            let significantChange = false;
            for (const mutation of mutations) {
                // Ignore changes within our own dialogs/highlights or script/style tags
                if (mutation.target.closest && (mutation.target.closest('.lingomarker-dialog') || mutation.target.closest('.lingomarker-highlight'))) {
                    continue;
                }
                if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
                    if (mutation.addedNodes.length > 0 && mutation.addedNodes[0].classList && mutation.addedNodes[0].classList.length > 0 && mutation.addedNodes[0].classList[0] === 'notranslate') {
                        break;
                    }
                    if (mutation.removedNodes.length > 0 && mutation.removedNodes[0].classList && mutation.removedNodes[0].classList.length > 0 && mutation.removedNodes[0].classList[0] === 'notranslate') {
                        break;
                    }
                    // Ignore changes to text nodes directly inside highlights?
                    let isHighlightTextChange = false;
                    if (mutation.target.classList?.contains('lingomarker-highlight') && mutation.addedNodes.length === 1 && mutation.addedNodes[0].nodeType === Node.TEXT_NODE) {
                        isHighlightTextChange = true;
                    }
                    if (!isHighlightTextChange) {
                        significantChange = true;
                        break;
                    }
                } else if (mutation.type === 'characterData') {
                    // Character data changes outside highlights might be significant
                    if (!mutation.target.parentElement?.closest('.lingomarker-highlight')) {
                        significantChange = true;
                        break;
                    }
                }
            }

            if (significantChange && !isHighlighting) {
                // console.log("Mutation observed, triggering highlight refresh.");
                safeApplyHighlights();
            }
        });

        observeMutations(); // Start observing
    }

    function observeMutations() {
        if (!mutationObserverInstance || !document.body) return;
        try {
            mutationObserverInstance.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true, // Observe text changes too, filter noise in callback
            });
            // console.log('Observer connected');
        } catch (e) {
            console.error('Error connecting MutationObserver:', e);
        }
    }

    // --- Core Selection Logic ---
    // Extracted core logic callable by both mouseup and debounced selectionchange
    async function handleSelectionLogic(selection, node) {
        if (!isAuthenticated || !selection || !node) return;

        const caption = selection.toString().trim().replace(/[.,?!"“”]/g, '');
        const word = caption.toLowerCase();

        // --- Basic Validation ---
        if (!word || word.includes('\n') || selection.rangeCount === 0) return;
        const wordCount = word.split(/\s+/).filter(Boolean).length;
        if (wordCount === 0 || wordCount > wordsNumberLimit || word.length > wordsLengthLimit) {
            console.log(`Selection invalid: count=${wordCount}, length=${word.length}`);
            if (isDialogActive) {
                const dialog = document.querySelector('.lingomarker-dialog');
                if (dialog) closeDialogVisuals(dialog); // Close visuals only
            }
            return;
        }
        // --- End Validation ---

        // --- Check if Known Word ---
        const existingEntry = findEntryByWordForm(word);
        if (existingEntry) {
            if (isDialogActive) {
                const dialog = document.querySelector('.lingomarker-dialog');
                if (dialog) closeDialogVisuals(dialog); // Close visuals only
            }
            console.log(`Known word "${caption}" selected. Updating timestamp.`);
            const context = await getContextFromNode(node);
            if (context) {
                const transcriptSegmentRef = getTranscriptSegmentRef(node);
                try {
                    await apiRequest('POST', '/api/mark', {
                        word: existingEntry.word,
                        entryUUID: existingEntry.uuid,
                        url: context.url,
                        title: context.title,
                        paragraphText: context.paragraphText,
                        urlHash: context.urlHash,
                        paragraphHash: context.paragraphHash,
                        transcriptSegmentRef: transcriptSegmentRef,
                    });
                } catch (error) {
                    console.error("Failed to update context timestamp:", error);
                }
            }
            // ACTION: Clear selection because we acted on it (timestamp).
            /// if (window.getSelection) window.getSelection().removeAllRanges();
            return; // Don't show dialog
        }
        // --- End Check Known Word ---


        // --- Handle NEW Word Selection ---
        console.log(`New word selected: "${caption}". Preparing dialog.`);
        // Set flag *before* showing dialog to prevent immediate re-triggering
        isDialogActive = true;

        // Show the context dialog
        showContextDialog(selection, caption, async () => {
            // --- Dialog Confirmation Callback ---
            console.log(`Marking new word from dialog: "${caption}"`);
            // Get context using the original node
            const context = await getContextFromNode(node);
            if (!context) {
                console.error("Failed to get context for selection (dialog callback).");
                alert("LingoMarker: Could not determine the context (paragraph/URL).");
                isDialogActive = false; // Reset flag on error before returning
                return;
            }

            const transcriptSegmentRef = getTranscriptSegmentRef(node);

            try {
                // Call backend API
                const newEntry = await apiRequest('POST', '/api/mark', {
                    word: word, // Use word captured when dialog was created
                    url: context.url,
                    title: context.title,
                    paragraphText: context.paragraphText,
                    urlHash: context.urlHash,
                    paragraphHash: context.paragraphHash,
                    transcriptSegmentRef: transcriptSegmentRef,
                });
                console.log("Word marked successfully.", newEntry);

                // Update local cache & highlights
                if (newEntry && newEntry.uuid) {
                    // (Cache update logic...)
                    const existingIndex = userData.entries.findIndex(e => e.uuid === newEntry.uuid);
                    if (existingIndex > -1) { userData.entries[existingIndex] = { ...userData.entries[existingIndex], ...newEntry }; }
                    else { userData.entries.push(newEntry); }
                    if (!userData.urls.some(u => u.urlHash === context.urlHash)) { userData.urls.push({ urlHash: context.urlHash, url: context.url, title: context.title, createdAt: new Date().toISOString() }); }
                    if (!userData.paragraphs.some(p => p.paragraphHash === context.paragraphHash)) { userData.paragraphs.push({ paragraphHash: context.paragraphHash, text: context.paragraphText, createdAt: new Date().toISOString() }); }
                    const relIndex = userData.relations.findIndex(r => r.entryUUID === newEntry.uuid && r.urlHash === context.urlHash && r.paragraphHash === context.paragraphHash);
                    const now = new Date().toISOString();
                    if (relIndex > -1) { userData.relations[relIndex].updatedAt = now; }
                    else { userData.relations.push({ entryUUID: newEntry.uuid, urlHash: context.urlHash, paragraphHash: context.paragraphHash, createdAt: now, updatedAt: now }); }
                    safeApplyHighlights();
                } else {
                    await fetchUserDataAndHighlight(); // Fallback refresh
                }

            } catch (error) {
                console.error("Failed to mark word via API (dialog callback):", error);
                // (Error alert logic...)
                let errorMsg = "LingoMarker: Failed to save the word.";
                if (error.message?.includes("API key not configured")) { errorMsg += " Please set your Gemini API key in the LingoMarker settings."; }
                else if (error.message?.includes("Failed to retrieve word forms")) { errorMsg += " Could not get word forms from the API."; }
                else if (error.message?.includes("Unauthorized")) { errorMsg = "LingoMarker: Authentication error. Please log in again."; }
                alert(errorMsg);
            } finally {
                // ACTION: Reset flag and clear selection *after* confirmation callback completes.
                isDialogActive = false;
                if (window.getSelection) window.getSelection().removeAllRanges();
            }
            // --- End Dialog Confirmation Callback ---
        });
    }

    // Debounced wrapper for selectionchange
    // --- Debounced Handler for Touch ---
    const debouncedHandleSelection = _.debounce(async () => {
        if (!isAuthenticated) { // Check flag
            return;
        }
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) { return; }

        const node = selection.focusNode;
        if (!node) { return; }

        // Check if inside highlight
        const range = selection.getRangeAt(0);
        const commonAncestor = range.commonAncestorContainer;
        let isInsideHighlight = false;
        if (commonAncestor) {
            if (commonAncestor.nodeType === Node.ELEMENT_NODE && commonAncestor.classList?.contains('lingomarker-highlight')) { isInsideHighlight = true; }
            else if (commonAncestor.parentElement?.closest('.lingomarker-highlight')) { isInsideHighlight = true; }
            if (!isInsideHighlight && range.startContainer === range.endContainer && range.startContainer.parentElement?.classList.contains('lingomarker-highlight')) { isInsideHighlight = true; }
        }
        if (isInsideHighlight) {
            if (isDialogActive) {
                const dialog = document.querySelector('.lingomarker-dialog');
                if (dialog) closeDialogVisuals(dialog); // Close visuals only
            }
            // ACTION: Clear selection artifact from clicking highlight.
            /// if (window.getSelection) window.getSelection().removeAllRanges();
            return;
        }

        // Call the core logic
        handleSelectionLogic(selection, node);

    }, 300);

    // --- Direct Handler for Mouse ---
    function handleMouseUpSelection() {
        const selection = window.getSelection();
        // Add isDialogActive check here too for consistency
        if (!isDialogActive && selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.toString().trim() !== '') {
            const node = selection.focusNode;
            if (!node) return;

            // Check if inside highlight
            const range = selection.getRangeAt(0);
            const commonAncestor = range.commonAncestorContainer;
            let isInsideHighlight = false;
            if (commonAncestor) { /* ... highlight check logic ... */ }
            if (isInsideHighlight) {
                if (isDialogActive) {
                    const dialog = document.querySelector('.lingomarker-dialog');
                    if (dialog) closeDialogVisuals(dialog); // Close visuals only
                }
                // ACTION: Clear selection artifact from clicking highlight.
                /// if (window.getSelection) window.getSelection().removeAllRanges();
            } else {
                handleSelectionLogic(selection, node); // Call core logic directly
            }
        } else if (isDialogActive) {
            // console.log("Mouseup ignored, dialog is active.");
        }
    }

    // --- Event Listeners ---

    // --- Event Listener Setup ---
    function setupEventListeners() {
        if (!touchScreen) {
            // Desktop: Use mouseup
            document.addEventListener('mouseup', () => {
                // No need for setTimeout if handleMouseUpSelection is robust
                // setTimeout(handleMouseUpSelection, 50);
                handleMouseUpSelection(); // Call directly on mouseup
            });
        } else {
            // Touch: Use debounced selectionchange
            document.addEventListener('selectionchange', debouncedHandleSelection);
        }

        // Visibility change listener (remains the same)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                console.log("Tab became visible, re-checking auth and data.");
                checkAuthAndFetchSettings().then(() => {
                    if (isAuthenticated) { fetchUserDataAndHighlight(); }
                    else { safeApplyHighlights(); }
                });
            }
        });
    }

    // --- Menu Commands ---

    function registerMenuCommands() {
        GM_registerMenuCommand("Reload LingoMarker Data", fetchUserDataAndHighlight);
        GM_registerMenuCommand("Go to Review Page", () => {
            GM_openInTab(BACKEND_URL + '/review', { active: true });
        });
        GM_registerMenuCommand("Go to Settings", () => {
            GM_openInTab(BACKEND_URL + '/settings', { active: true });
        });

        // Command to manually import data (Temporary)
        GM_registerMenuCommand("Import Old Data (JSON)", async () => {
            if (!isAuthenticated) {
                alert("Please log in before importing data.");
                showLoginPrompt();
                return;
            }
            const jsonData = prompt("Paste your exported JSON data here:");
            if (!jsonData) {
                alert("Import cancelled.");
                return;
            }
            try {
                const parsedData = JSON.parse(jsonData);
                // Optional: Basic validation of the pasted structure
                if (typeof parsedData !== 'object' || parsedData === null) {
                    throw new Error("Invalid JSON structure.");
                }

                alert("Importing data... This may take a moment.");
                const result = await apiRequest('POST', '/api/import', parsedData);
                alert(`Import Complete!\nEntries: ${result.importedEntries}\nURLs: ${result.importedUrls}\nParagraphs: ${result.importedParagraphs}\nRelations: ${result.importedRelations}`);
                await fetchUserDataAndHighlight(); // Refresh highlights
            } catch (error) {
                console.error("Import failed:", error);
                alert(`Import failed: ${error.message}`);
            }
        });

        // Command to remove entries (if on dictionary page - adapt if needed)
        // This logic might need removal or rethinking if not using Lingea directly
        if (window.location.href.startsWith(dictBaseUrl)) {
            GM_registerMenuCommand("Remove This Entry (Lingea)", async () => {
                const entryWord = decodeURIComponent(window.location.href.split(dictBaseUrl)[1]).trim().toLowerCase();
                if (!entryWord) return;

                const entry = findEntryByWordForm(entryWord); // Find by base form
                if (!entry) {
                    alert(`Entry for "${entryWord}" not found in your LingoMarker data.`);
                    return;
                }

                if (confirm(`Are you sure you want to remove the entry for "${entry.word}" and all its occurrences?`)) {
                    try {
                        await apiRequest('DELETE', `/api/entries/${entry.uuid}`);
                        alert(`Entry "${entry.word}" removed successfully.`);
                        // Remove from local cache
                        userData.entries = userData.entries.filter(e => e.uuid !== entry.uuid);
                        userData.relations = userData.relations.filter(r => r.entryUUID !== entry.uuid);
                        // Optionally remove orphaned URLs/Paragraphs from local cache if desired
                        safeApplyHighlights(); // Re-apply highlights (will remove the word)
                        // Maybe close the dictionary tab?
                        // window.close();
                    } catch (error) {
                        console.error("Failed to remove entry:", error);
                        alert(`Failed to remove entry: ${error.message}`);
                    }
                }
            });
        }
    }

    // --- Run Initialization ---
    // Wait for the body element to be fully available
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})();