// ==UserScript==
// @name         LingoMarker
// @namespace    http://tampermonkey.net/
// @version      0.4
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
// @match        https://*.lingea.sk/*
// @match        https://dev.lingomarker.com:*/*
// @exclude      https://dev.lingomarker.com/login*
// @exclude      https://dev.lingomarker.com/register*
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

        // ... (rest of initialize function: init Mark.js, fetch data, setup listeners) ...
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

        console.log(`Clicked existing highlight: Word='${clickedWord}', EntryUUID='${entry.uuid}', URL='${context.url}', ParagraphHash='${context.paragraphHash}'`);

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

    function showContextDialog(selection, caption, callback) {
        lastTrigger = Date.now(); // Update last trigger time

        // Remove any existing dialogs immediately
        const existingDialogs = document.querySelectorAll('.lingomarker-dialog');
        existingDialogs.forEach(d => d.remove());


        // Create dialog element
        const dialog = document.createElement('div');
        dialog.className = 'lingomarker-dialog notranslate'; // Add notranslate class

        // Position dialog near selection
        const range = selection.getRangeAt(0).cloneRange();
        const rect = range.getBoundingClientRect();

        Object.assign(dialog.style, {
            position: 'absolute',
            left: `${rect.left + window.scrollX}px`,
            top: `${rect.bottom + window.scrollY + 20}px`, // Further from the selection
            zIndex: 9999999999999,
            background: 'white',
            padding: '5px 10px', // Smaller padding
            borderRadius: '4px',
            boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
            fontSize: '14px', // Smaller font
            textAlign: 'center',
            cursor: 'pointer',
            border: '1px solid #ccc',
            // Use highlight color? Or keep white?
            // backgroundColor: 'rgb(208, 180, 111)',
            // border: '1px solid rgb(74, 63, 36)',
        });

        dialog.textContent = `Mark "${caption}"`; // Simple text


        // Add click handler to the dialog itself
        dialog.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeDialog(dialog); // Use closeDialog function
            if (callback) callback();
        });


        // --- Disconnect observer before adding dialog ---
        if (mutationObserverInstance) {
            mutationObserverInstance.disconnect();
        }

        document.body.appendChild(dialog);


        //  Auto-close after 3 seconds
        setTimeout(() => closeDialog(dialog), 3000);

        /// ??? Close on outside click (add after a short delay to prevent immediate close)
        setTimeout(() => {
            document.addEventListener('click', closeDialogOnClickOutside, true);
        }, 50);

        // --- Reconnect observer ---
        observeMutations(); // Reconnect after adding dialog and setting up listener

        return dialog;
    }

    function closeDialog(dialog) {
        if (dialog && dialog.parentNode) { // Check if dialog exists and is in DOM
            dialog.remove();
            // Clean up the outside click listener if it was added for this dialog instance
            // This might be tricky if multiple dialogs could exist briefly.
            // A safer approach might be to associate the listener directly with the dialog
            // or have the listener check if ANY dialogs remain before removing itself.
            document.removeEventListener('click', closeDialogOnClickOutside, true); // Try removing the general listener
        }
    }

    function closeDialogOnClickOutside(event) {
        const existingDialogs = document.querySelectorAll('.lingomarker-dialog');
        // Check if the click was outside ALL dialogs
        let clickedOutside = true;
        existingDialogs.forEach(dialog => {
            if (dialog.contains(event.target)) {
                clickedOutside = false;
            }
        });

        if (clickedOutside) {
            // console.log("Clicked outside dialog, closing.");
            existingDialogs.forEach(d => d.remove());
            document.removeEventListener('click', closeDialogOnClickOutside, true); // Clean up listener
        }
    }


    async function sha256(message) {
        const msgBuffer = new TextEncoder().encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    function getUrlFromNode(node) {
        // Find the nearest parent A tag with an href, or use window.location
        let current = node;
        while (current && current !== document.body) {
            if (current.nodeName === 'A' && current.href) {
                // Check if it's an internal page link
                if (current.href.startsWith(window.location.origin + '/#')) {
                    // Internal link, prefer window.location.href
                } else if (current.href.startsWith('http')) {
                    // Prefer the link's href if it's a full URL
                    return current.href;
                }
            }
            current = current.parentNode;
        }


        // Fallback to window location
        let url = window.location.href;
        // Special handling for training page? Not needed now backend serves it.
        return url;
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

    async function handleSelection() {
        if (!isAuthenticated) return; // Don't process if not logged in

        const selection = window.getSelection();
        const node = selection.focusNode;
        if (!node) return;

        const caption = selection.toString().trim().replace(/[.,?!"“”]/g, ''); // Clean basic punctuation
        const word = caption.toLowerCase(); // Use lowercase internally

        // Validate selection
        if (!word || word.includes('\n') || selection.rangeCount === 0) return; // Ignore multi-line or empty
        const wordCount = word.split(/\s+/).filter(Boolean).length;
        if (wordCount === 0 || wordCount > wordsNumberLimit || word.length > wordsLengthLimit) return;

        // --- Check if the selected word is already known ---
        const existingEntry = findEntryByWordForm(word);
        if (existingEntry) {
            console.log(`Word "${caption}" is already known (Base: ${existingEntry.word}). Updating context timestamp.`);
            // Update timestamp by re-sending mark request
            const context = await getContextFromNode(node);
            if (context) {
                try {
                    await apiRequest('POST', '/api/mark', {
                        word: existingEntry.word,
                        entryUUID: existingEntry.uuid,
                        url: context.url,
                        title: context.title,
                        paragraphText: context.paragraphText,
                        urlHash: context.urlHash,
                        paragraphHash: context.paragraphHash,
                    });
                    // Maybe provide visual feedback? E.g., flash the highlight briefly
                } catch (error) {
                    console.error("Failed to update context timestamp:", error);
                }
            }
            // Remove selection range after processing
            selection.removeAllRanges();
            // Don't show dialog for already known words
            return;
        }
        // --- End check if word is known ---

        // Show dialog for new highlights
        showContextDialog(selection, caption, async () => {
            // Get context (paragraph, URL)
            const context = await getContextFromNode(node);
            if (!context) {
                console.error("Failed to get context for selection.");
                // Provide user feedback?
                alert("LingoMarker: Could not determine the context (paragraph/URL) for the selected word.");
                return;
            }

            try {
                // Call backend API to mark the word
                const newEntry = await apiRequest('POST', '/api/mark', {
                    word: word, // Send lowercase base word candidate
                    // entryUUID is null here, backend will generate
                    url: context.url,
                    title: context.title,
                    paragraphText: context.paragraphText,
                    urlHash: context.urlHash,
                    paragraphHash: context.paragraphHash,
                });

                // --- Success ---
                console.log("Word marked successfully. Backend Entry:", newEntry);

                // Add the new entry data to the local cache immediately for faster highlight update
                if (newEntry && newEntry.uuid) {
                    // Add/update entry in local cache
                    const existingIndex = userData.entries.findIndex(e => e.uuid === newEntry.uuid);
                    if (existingIndex > -1) {
                        userData.entries[existingIndex] = { ...userData.entries[existingIndex], ...newEntry }; // Merge updates
                    } else {
                        userData.entries.push(newEntry);
                    }

                    // Add/update URL and Paragraph (optional, backend stores them, but might be needed if GetUserDataBundle doesn't return *all*)
                    if (!userData.urls.some(u => u.urlHash === context.urlHash)) {
                        userData.urls.push({ urlHash: context.urlHash, url: context.url, title: context.title, createdAt: new Date().toISOString() });
                    }
                    if (!userData.paragraphs.some(p => p.paragraphHash === context.paragraphHash)) {
                        userData.paragraphs.push({ paragraphHash: context.paragraphHash, text: context.paragraphText, createdAt: new Date().toISOString() });
                    }

                    // Add/update Relation
                    const relIndex = userData.relations.findIndex(r => r.entryUUID === newEntry.uuid && r.urlHash === context.urlHash && r.paragraphHash === context.paragraphHash);
                    const now = new Date().toISOString();
                    if (relIndex > -1) {
                        userData.relations[relIndex].updatedAt = now;
                    } else {
                        userData.relations.push({ entryUUID: newEntry.uuid, urlHash: context.urlHash, paragraphHash: context.paragraphHash, createdAt: now, updatedAt: now });
                    }


                    // Re-apply highlights immediately with updated local data
                    safeApplyHighlights();
                } else {
                    // If backend didn't return a valid entry, fetch all data again
                    await fetchUserDataAndHighlight();
                }


            } catch (error) {
                console.error("Failed to mark word via API:", error);
                // Show specific error message if possible
                let errorMsg = "LingoMarker: Failed to save the word.";
                if (error.message?.includes("API key not configured")) {
                    errorMsg += " Please set your Gemini API key in the LingoMarker settings.";
                } else if (error.message?.includes("Failed to retrieve word forms")) {
                    errorMsg += " Could not get word forms from the API.";
                } else if (error.message?.includes("Unauthorized")) {
                    errorMsg = "LingoMarker: Authentication error. Please log in again.";
                }
                alert(errorMsg);
            } finally {
                // Clear selection regardless of success/failure after dialog action
                if (window.getSelection) {
                    window.getSelection().removeAllRanges();
                }
            }
        }); // End of showContextDialog callback
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

    // --- Debounced Selection Handler ---
    // Create the debounced function *once*
    const debouncedHandleSelection = _.debounce(async () => {
        if (!isAuthenticated) return; // Don't process if not logged in

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            // No active selection when the debounce fires, do nothing
            return;
        }

        const node = selection.focusNode; // Get the node *when the debounce executes*
        if (!node) return; // Should generally exist if not collapsed

        const caption = selection.toString().trim().replace(/[.,?!"“”]/g, '');
        const word = caption.toLowerCase();

        // --- Re-check validation inside debounced function ---
        if (!word || word.includes('\n')) return; // Ignore multi-line or empty
        const wordCount = word.split(/\s+/).filter(Boolean).length;
        if (wordCount === 0 || wordCount > wordsNumberLimit || word.length > wordsLengthLimit) {
            // Selection became invalid between event and debounce fire
            return;
        }
        // --- End Re-check ---

        // --- Check if clicking inside an existing highlight ---
        // This check helps differentiate selecting new text vs. interacting with existing highlight
        const range = selection.getRangeAt(0);
        const commonAncestor = range.commonAncestorContainer;
        // Check if the selection itself or its immediate parent is inside a highlight
        // This handles cases where the selection might span multiple nodes within the highlight
        let isInsideHighlight = false;
        if (commonAncestor) {
            if (commonAncestor.nodeType === Node.ELEMENT_NODE && commonAncestor.classList?.contains('lingomarker-highlight')) {
                isInsideHighlight = true;
            } else if (commonAncestor.parentElement?.closest('.lingomarker-highlight')) {
                isInsideHighlight = true;
            }
            // Additional check: if the selection is *exactly* the text of a highlight span
            if (!isInsideHighlight && range.startContainer === range.endContainer && range.startContainer.parentElement?.classList.contains('lingomarker-highlight')) {
                isInsideHighlight = true;
            }
        }

        if (isInsideHighlight) {
            // Likely an accidental selection during/after clicking a highlight.
            // Clear it and let the highlight's own click handler manage interaction.
            // console.log("Selection inside highlight ignored by debounced handler.");
            selection.removeAllRanges();
            return;
        }
        // --- End Check inside highlight ---


        // --- Check if the selected word is already known ---
        const existingEntry = findEntryByWordForm(word);
        if (existingEntry) {
            console.log(`Debounced: Word "${caption}" is already known (Base: ${existingEntry.word}). Updating context timestamp.`);
            const context = await getContextFromNode(node); // Use captured node
            if (context) {
                try {
                    await apiRequest('POST', '/api/mark', {
                        word: existingEntry.word, entryUUID: existingEntry.uuid,
                        url: context.url, title: context.title, paragraphText: context.paragraphText,
                        urlHash: context.urlHash, paragraphHash: context.paragraphHash,
                    });
                } catch (error) {
                    console.error("Failed to update context timestamp (debounced):", error);
                }
            }
            selection.removeAllRanges();
            return; // Don't show dialog for known words
        }
        // --- End check if word is known ---


        // --- Handle NEW word selection ---
        console.log(`Debounced: New selection detected for "${caption}"`);
        // Show dialog for new highlights
        showContextDialog(selection, caption, async () => {
            // Callback executed when user clicks the dialog
            console.log(`Marking new word from dialog: "${caption}"`);
            const context = await getContextFromNode(node); // Use node captured when dialog was created
            if (!context) {
                console.error("Failed to get context for selection (dialog callback).");
                alert("LingoMarker: Could not determine the context (paragraph/URL) for the selected word.");
                return;
            }

            try {
                const newEntry = await apiRequest('POST', '/api/mark', {
                    word: word, // Use word captured when dialog was created
                    url: context.url, title: context.title, paragraphText: context.paragraphText,
                    urlHash: context.urlHash, paragraphHash: context.paragraphHash,
                });
                console.log("Word marked successfully. Backend Entry:", newEntry);

                // Add to local cache immediately...
                if (newEntry && newEntry.uuid) {
                    // (Cache update logic as before)
                    const existingIndex = userData.entries.findIndex(e => e.uuid === newEntry.uuid);
                    if (existingIndex > -1) { userData.entries[existingIndex] = { ...userData.entries[existingIndex], ...newEntry }; }
                    else { userData.entries.push(newEntry); }
                    if (!userData.urls.some(u => u.urlHash === context.urlHash)) { userData.urls.push({ urlHash: context.urlHash, url: context.url, title: context.title, createdAt: new Date().toISOString() }); }
                    if (!userData.paragraphs.some(p => p.paragraphHash === context.paragraphHash)) { userData.paragraphs.push({ paragraphHash: context.paragraphHash, text: context.paragraphText, createdAt: new Date().toISOString() }); }
                    const relIndex = userData.relations.findIndex(r => r.entryUUID === newEntry.uuid && r.urlHash === context.urlHash && r.paragraphHash === context.paragraphHash);
                    const now = new Date().toISOString();
                    if (relIndex > -1) { userData.relations[relIndex].updatedAt = now; }
                    else { userData.relations.push({ entryUUID: newEntry.uuid, urlHash: context.urlHash, paragraphHash: context.paragraphHash, createdAt: now, updatedAt: now }); }

                    safeApplyHighlights(); // Re-apply highlights
                } else {
                    await fetchUserDataAndHighlight(); // Fallback refresh
                }

            } catch (error) {
                // (Error handling as before)
                console.error("Failed to mark word via API (dialog callback):", error);
                let errorMsg = "LingoMarker: Failed to save the word.";
                if (error.message?.includes("API key not configured")) { errorMsg += " Please set your Gemini API key in the LingoMarker settings."; }
                else if (error.message?.includes("Failed to retrieve word forms")) { errorMsg += " Could not get word forms from the API."; }
                else if (error.message?.includes("Unauthorized")) { errorMsg = "LingoMarker: Authentication error. Please log in again."; }
                alert(errorMsg);
            } finally {
                // Clear selection *after* dialog callback finishes
                if (window.getSelection) { window.getSelection().removeAllRanges(); }
            }
        }); // End of showContextDialog callback

    }, 500); // Debounce time in milliseconds (adjust 300-500ms as needed)

    // --- Event Listeners ---

    function setupEventListeners() {
        const touch = matchMedia('(hover: none), (pointer: coarse)').matches;

        console.log("Touch support:", touch);

        if (!touch) {
            // Use mouseup for selection end detection - often more reliable than selectionchange
            document.addEventListener('mouseup', () => {
                // Use setTimeout to allow selectionchange to possibly fire first
                // and to ensure the selection object is stable.
                setTimeout(() => {
                    const selection = window.getSelection();
                    if (selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.toString().trim() !== '') {
                        // Check if click was inside a highlight - handled by handleHighlightClick now
                        const range = selection.getRangeAt(0);
                        const commonAncestor = range.commonAncestorContainer;
                        const isInsideHighlight = commonAncestor.parentElement?.closest('.lingomarker-highlight') || commonAncestor.classList?.contains('lingomarker-highlight');

                        if (!isInsideHighlight) {
                            // It's a new selection, not just a click on existing highlight
                            handleSelection();
                        } else {
                            // Click inside existing highlight - selection might be browser artifact, clear it.
                            selection.removeAllRanges();
                        }
                    }
                }, 50); // Small delay
            });
        } else {
            document.addEventListener('selectionchange', debouncedHandleSelection);
        }

        // Keep visibility change listener
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                console.log("Tab became visible, re-checking auth and data.");
                checkAuthAndFetchSettings().then(() => { // Use the updated function name
                    if (isAuthenticated) {
                        fetchUserDataAndHighlight();
                    } else {
                        // Optional: Clear highlights if user logged out in another tab?
                        safeApplyHighlights(); // This will clear highlights if isAuthenticated is false
                    }
                });
            }
        });

        // Clicks on existing highlights are handled by the listener added in safeApplyHighlights/each
        // Clicks outside the dialog are handled by the listener added in showContextDialog
    }


    // --- Menu Commands ---

    function registerMenuCommands() {
        GM_registerMenuCommand("Reload LingoMarker Data", fetchUserDataAndHighlight);
        GM_registerMenuCommand("Go to Training Page", () => {
            GM_openInTab(BACKEND_URL + '/training', { active: true });
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