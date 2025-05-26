(function (global) {
    'use strict';

    // --- Configuration ---
    const BACKEND_URL = 'https://dev.lingomarker.com:8443'; // Adjust if served from same origin or needs to be configurable

    const DEBOUNCE_TIME = 1000;
    const MAX_HIGHLIGHTS = 10000; // Still relevant?
    const PAGE_SIZE_LIMIT = 1000000; // Limit for Mark.js initialization

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
    const touchScreen = typeof window.matchMedia === 'function' && matchMedia('(hover: none), (pointer: coarse)').matches;

    // --- Initialization ---

    async function initialize() {
        console.log("LingoMarker Library Initializing...");
        await checkAuthAndFetchSettings();

        if (!isAuthenticated) {
            console.warn("LingoMarker: User not authenticated. Features disabled.");
            if (!window.location.href.startsWith(BACKEND_URL + "/login") && !window.location.href.startsWith(BACKEND_URL + "/register")) {
                console.log("Please log in to LingoMarker backend to use the library's features.");
                showLoginPrompt();
            }
            // Do not return here if you want basic UI elements to still load,
            // but highlighting and data-dependent features will be off.
            // For now, let's allow styles to apply but data-driven features won't work.
        }

        console.log("LingoMarker: User authenticated:", currentUser);
        console.log("LingoMarker: Settings loaded:", { dictBaseUrl, highlightColor /* etc */ });

        applyStyles(); // Call applyStyles AFTER settings are fetched

        if (isAuthenticated) { // Only setup heavy features if authenticated
            if (document.body.textContent.length > PAGE_SIZE_LIMIT) {
                console.warn('Page too large for highlighting');
                return;
            }
            markInstance = new Mark(document.body);
            await fetchUserDataAndHighlight();
            setupEventListeners();
            setupMutationObserver();
        }

        console.log("LingoMarker Library Initialized Successfully.");
    }

    function applyStyles() {
        if (document.getElementById('lingomarker-global-styles')) {
            updateHighlightColorStyle(); // Just update if already exists
            return;
        }

        const styleEl = document.createElement('style');
        styleEl.id = 'lingomarker-global-styles';
        // Calculate initial hover color based on default highlightColor
        const initialHoverColor = calculateHoverColor(highlightColor);
        styleEl.textContent = `
            :root {
                --lingomarker-highlight-bg: ${highlightColor};
                --lingomarker-highlight-bg-hover: ${initialHoverColor};
            }

            .lingomarker-highlight {
                background-color: var(--lingomarker-highlight-bg) !important;
                cursor: pointer;
                transition: background-color 0.2s;
                text-decoration: none;
                padding-bottom: 1px;
                border-bottom: 1px dotted currentColor;
            }
            .lingomarker-highlight:hover {
                background-color: var(--lingomarker-highlight-bg-hover) !important;
            }
            .lingomarker-dialog {
               animation: lingomarker-fadein 0.15s ease-out;
               /* Copied styles from userscript */
               position: absolute;
               z-index: 9999999999999;
               background: white;
               background-color: rgb(208, 180, 111);
               padding: 8px 5px 8px 5px;
               border-radius: 4px;
               box-shadow: 0 1px 4px rgba(0,0,0,0.2);
               font-size: 14px;
               text-align: center;
               cursor: pointer;
               border: 1px solid #aaa;
            }
            .lingomarker-dialog a:hover {
               text-decoration: underline !important;
            }
            @keyframes lingomarker-fadein {
               from { opacity: 0; transform: translateY(-4px); }
               to { opacity: 1; transform: translateY(0); }
            }
            #lingomarker-login-prompt {
                position: fixed;
                bottom: 10px;
                left: 10px;
                background-color: #333;
                color: white;
                padding: 10px 15px;
                border-radius: 5px;
                z-index: 10000000;
                font-size: 14px;
                box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            }
            #lingomarker-login-prompt a {
                color: #7fdbff; /* Light blue, good on dark background */
                text-decoration: underline;
                cursor: pointer;
            }
        `;
        document.head.appendChild(styleEl);
        updateHighlightColorStyle(); // Update with fetched color if different
    }

    function updateHighlightColorStyle() {
        const hoverColor = calculateHoverColor(highlightColor);
        document.documentElement.style.setProperty('--lingomarker-highlight-bg', highlightColor);
        document.documentElement.style.setProperty('--lingomarker-highlight-bg-hover', hoverColor);
    }

    function calculateHoverColor(baseColor) {
        try {
            if (baseColor.startsWith('rgba(')) {
                const parts = baseColor.match(/[\d.]+/g);
                if (parts && parts.length === 4) {
                    const alpha = parseFloat(parts[3]);
                    const newAlpha = Math.min(1, alpha + 0.2);
                    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${newAlpha})`;
                }
            }
            // Fallback for non-RGBA or parse error
            return baseColor.includes('rgba') ? baseColor.replace(/(\d\.\d+)\)/, (match, p1) => `${Math.min(1, parseFloat(p1) + 0.2)})`) : 'rgba(210, 210, 10, 0.6)';
        } catch (e) {
            console.warn("Could not calculate hover color, using default.", e);
            return 'rgba(210, 210, 10, 0.6)'; // Default hover
        }
    }

    function showLoginPrompt() {
        if (document.getElementById('lingomarker-login-prompt')) return;

        const promptDiv = document.createElement('div');
        promptDiv.id = 'lingomarker-login-prompt';
        promptDiv.innerHTML = `LingoMarker: Please <a id="lingomarker-login-link">log in</a> to save words.`;
        document.body.appendChild(promptDiv);

        const loginLink = document.getElementById('lingomarker-login-link');
        if (loginLink) {
            loginLink.addEventListener('click', () => {
                window.open(BACKEND_URL + '/login', '_blank');
                promptDiv.remove();
            });
        }
    }

    // --- Authentication & API Calls ---

    async function apiRequest(method, path, data = null) {
        const url = BACKEND_URL + path;
        const options = {
            method: method,
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            credentials: 'include', // For session cookies
        };

        if (data) {
            options.body = JSON.stringify(data);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 seconds timeout
        options.signal = controller.signal;

        try {
            const response = await fetch(url, options);
            clearTimeout(timeoutId);
            const responseText = await response.text();

            if (response.ok) {
                try {
                    return JSON.parse(responseText || '{}');
                } catch (e) {
                    console.error("Failed to parse JSON response:", responseText, e);
                    if (response.status === 200 || response.status === 204) {
                        return {};
                    }
                    throw new Error("Failed to parse JSON response");
                }
            } else if (response.status === 401) {
                isAuthenticated = false;
                currentUser = null;
                console.warn(`LingoMarker: Unauthorized (${response.status}) accessing ${path}. Need login.`);
                if (markInstance) safeApplyHighlights(); // Re-apply (will likely clear highlights)
                showLoginPrompt();
                throw new Error(`Unauthorized (${response.status})`);
            } else {
                let errorMsg = `Request failed (${response.status})`;
                try {
                    const errorData = JSON.parse(responseText);
                    if (errorData && errorData.error) {
                        errorMsg += ": " + errorData.error;
                    }
                } catch (e) { /* Ignore parse error */ }
                console.error(`LingoMarker API Error accessing ${path}:`, errorMsg, responseText);
                throw new Error(errorMsg);
            }
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                console.error(`LingoMarker Timeout accessing ${path}`);
                throw new Error("Request timed out");
            }
            console.error(`LingoMarker Network Error accessing ${path}:`, error);
            // If it's a TypeError, it's often a CORS issue or network down.
            if (error instanceof TypeError && error.message === "Failed to fetch") {
                 console.error("Fetch failed. This could be a CORS issue if accessing a different origin, or the server is down. Ensure the backend is configured for CORS if necessary.");
            }
            throw new Error("Network error or backend unreachable");
        }
    }

    async function checkAuthAndFetchSettings() {
        try {
            const data = await apiRequest('GET', '/api/session');
            if (data.authenticated && data.settings) {
                isAuthenticated = true;
                currentUser = {
                    userID: data.userID,
                    username: data.username,
                    name: data.name,
                };

                const settings = data.settings;
                highlightColor = settings.highlightColor || highlightColor;
                wordsNumberLimit = settings.wordsNumberLimit || wordsNumberLimit;
                wordsLengthLimit = settings.wordsLengthLimit || wordsLengthLimit;
                dictBaseUrl = settings.dictBaseUrl || dictBaseUrl;

                if (settings.allowFragmentUrlList && typeof settings.allowFragmentUrlList === 'string') {
                    allowFragmentUrlList = settings.allowFragmentUrlList.split(',')
                        .map(url => url.trim())
                        .filter(url => url.length > 0);
                } else {
                    allowFragmentUrlList = ['https://www.nytimes.com/', 'https://developer.mozilla.org/']; // Default
                }

                const promptDiv = document.getElementById('lingomarker-login-prompt');
                if (promptDiv) promptDiv.remove();
            } else {
                isAuthenticated = false;
                currentUser = null;
            }
        } catch (error) {
            isAuthenticated = false;
            currentUser = null;
            // Error already logged in apiRequest
        }
    }

    async function fetchUserDataAndHighlight() {
        if (!isAuthenticated || !markInstance) { // Also check markInstance
            if (!isAuthenticated) console.log("Not authenticated, skipping data fetch.");
            if (!markInstance && isAuthenticated) console.log("Mark.js not initialized, skipping data fetch.");
            return;
        }
        try {
            console.log("Fetching user data...");
            const bundle = await apiRequest('GET', '/api/data');
            if (bundle && Array.isArray(bundle.entries) && Array.isArray(bundle.urls) && Array.isArray(bundle.paragraphs) && Array.isArray(bundle.relations)) {
                userData = bundle;
                console.log(`Fetched ${userData.entries.length} entries, ${userData.relations.length} relations.`);
            } else {
                console.error("Invalid data structure received from /api/data:", bundle);
                userData = { entries: [], urls: [], paragraphs: [], relations: [] };
            }
        } catch (error) {
            console.error("Failed to fetch user data:", error);
            userData = { entries: [], urls: [], paragraphs: [], relations: [] };
        } finally {
            safeApplyHighlights(); // Apply highlights (or clear them if data fetch failed)
        }
    }

    // --- Highlighting Logic ---

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function getRegexFromUserData() {
        if (!userData || !userData.entries || userData.entries.length === 0) {
            return null;
        }
        const allForms = new Set();
        userData.entries.forEach(entry => {
            if (entry.formsPipeSeparated) {
                entry.formsPipeSeparated.split('|').forEach(form => {
                    if (form) allForms.add(escapeRegex(form.trim()));
                });
            } else if (entry.word) {
                allForms.add(escapeRegex(entry.word.trim()));
            }
        });
        if (allForms.size === 0) return null;
        const sortedForms = Array.from(allForms).sort((a, b) => b.length - a.length);
        const pattern = `\\b(?:${sortedForms.join('|')})\\b`;
        return new RegExp(pattern, 'gi');
    }

    const safeApplyHighlights = _.debounce(async () => {
        if (isHighlighting || !markInstance) return;
        if (!isAuthenticated) {
            markInstance.unmark();
            return;
        }

        isHighlighting = true;
        if (mutationObserverInstance) mutationObserverInstance.disconnect();

        const regex = getRegexFromUserData();

        markInstance.unmark({
            exclude: ['span[data-immersive-translate-walked]'],
            done: () => {
                if (!regex) {
                    isHighlighting = false;
                    observeMutations();
                    return;
                }
                markInstance.markRegExp(regex, {
                    exclude: ['.lingomarker-dialog', 'script', 'style', 'noscript', 'textarea', 'input', 'select'],
                    element: 'span',
                    className: 'lingomarker-highlight',
                    acrossElements: true,
                    separateWordSearch: false,
                    iframes: false, // Standard behavior for web pages, userscripts sometimes enable this
                    each: (node) => {
                        node.addEventListener('click', handleHighlightClick);
                    },
                    done: () => {
                        isHighlighting = false;
                        observeMutations();
                    },
                    filter: (textNode) => {
                        let parent = textNode.parentNode;
                        while (parent && parent !== document.body) {
                            if (parent.classList && (parent.classList.contains('lingomarker-dialog') || parent.classList.contains('lingomarker-highlight'))) {
                                return false;
                            }
                            parent = parent.parentNode;
                        }
                        return true;
                    }
                });
            }
        });
    }, 300);

    function getTranscriptSegmentRef(node) {
        let transcriptSegmentRef = null;
        if (window.location.pathname.startsWith('/podcasts/play/')) {
            let elementForClosest = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            if (elementForClosest) {
                const segmentElement = elementForClosest.closest('.transcript-segment');
                if (segmentElement && segmentElement.dataset.timestamp) {
                    transcriptSegmentRef = segmentElement.dataset.timestamp;
                }
            }
        } else if (window.location.pathname.startsWith('/review')) {
             let elementForClosest = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
            if (elementForClosest) {
                // Adjusted selector for review page based on its structure
                const paragraphElement = elementForClosest.closest('.review-paragraph');
                if (paragraphElement) {
                    const segmentIcon = paragraphElement.querySelector("a.goto-segment-icon");
                    if (segmentIcon && segmentIcon.href && segmentIcon.href.includes('#segment_timestamp=')) {
                         try {
                            const urlParams = new URLSearchParams(segmentIcon.href.split('#')[1]);
                            transcriptSegmentRef = urlParams.get('segment_timestamp');
                        } catch (e) {
                            console.error("Error parsing transcriptSegmentRef from review page icon:", e);
                        }
                    }
                }
            }
        }
        if (transcriptSegmentRef) console.log("Found segment ref:", transcriptSegmentRef);
        return transcriptSegmentRef;
    }

    async function handleHighlightClick(event) {
        event.preventDefault();
        event.stopPropagation();
        if (!isAuthenticated) return;

        const node = event.target;
        const clickedWord = node.textContent.trim().toLowerCase();
        const entry = findEntryByWordForm(clickedWord);

        if (!entry) {
            console.warn("Clicked highlight, but couldn't find matching entry for:", clickedWord);
            return;
        }

        const context = await getContextFromNode(node);
        if (!context) {
            console.warn("Could not determine context for clicked highlight.");
            return;
        }

        const transcriptSegmentRef = getTranscriptSegmentRef(node);
        console.log(`Clicked existing highlight: Word='${clickedWord}', EntryUUID='${entry.uuid}', URL='${context.url}', ParagraphHash='${context.paragraphHash}', transcriptSegmentRef='${transcriptSegmentRef}`);

        try {
            await apiRequest('POST', '/api/mark', {
                word: entry.word,
                entryUUID: entry.uuid,
                url: context.url,
                title: context.title,
                paragraphText: context.paragraphText,
                urlHash: context.urlHash,
                paragraphHash: context.paragraphHash,
                transcriptSegmentRef: transcriptSegmentRef,
            });
            console.log("Relation timestamp updated for:", entry.word);
            window.open(createDictionaryLink(entry.word), 'Lingea'); // Opens in new tab/window named 'Lingea'
        } catch (error) {
            console.error("Failed to update relation timestamp:", error);
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

    // --- Selection Handling & Dialog ---

    function showContextDialog(selection, caption, callback) {
        lastTrigger = Date.now();
        let dialog = document.querySelector('.lingomarker-dialog');

        if (dialog) { // If dialog exists, clear its timeout and reuse it
            if (dialog.dataset.timeoutId) clearTimeout(dialog.dataset.timeoutId);
        } else { // Create new dialog
            dialog = document.createElement('div');
            dialog.className = 'lingomarker-dialog notranslate'; // notranslate to prevent translation services
            const range = selection.getRangeAt(0).cloneRange();
            const rect = range.getBoundingClientRect();
            Object.assign(dialog.style, { // Styles are now mostly in CSS, but position is dynamic
                left: `${rect.left + window.scrollX}px`,
                top: `${rect.bottom + window.scrollY + (touchScreen ? 28 : 5)}px`,
            });

            dialog.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeDialogVisuals(dialog);
                if (dialog.dataset.timeoutId) clearTimeout(dialog.dataset.timeoutId);
                document.removeEventListener('click', outsideClickListener, true);
                if (callback) callback();
            });

            if (mutationObserverInstance) mutationObserverInstance.disconnect();
            document.body.appendChild(dialog);
        }

        // Common logic for new or reused dialog
        dialog.textContent = `Mark "${caption}"`;

        const timeoutId = setTimeout(() => {
            console.log("Dialog timed out.");
            closeDialogVisuals(dialog);
            isDialogActive = false;
            document.removeEventListener('click', outsideClickListener, true);
        }, 5000);
        dialog.dataset.timeoutId = timeoutId;

        // Define outsideClickListener here to ensure it's fresh for each dialog show
        // and can be correctly removed.
        const outsideClickListener = (event) => {
            const currentDialog = document.querySelector('.lingomarker-dialog');
            if (currentDialog && !currentDialog.contains(event.target)) {
                console.log("Clicked outside dialog.");
                if (currentDialog.dataset.timeoutId) clearTimeout(currentDialog.dataset.timeoutId);
                closeDialogVisuals(currentDialog);
                isDialogActive = false;
                document.removeEventListener('click', outsideClickListener, true);
            }
        };
        dialog.dataset.outsideClickListenerRef = outsideClickListener; // Store for potential explicit removal if needed

        setTimeout(() => { // Delay adding listener slightly
            document.addEventListener('click', outsideClickListener, true);
        }, 50);

        if (mutationObserverInstance) observeMutations(); // Re-observe if it was disconnected
        return dialog;
    }

    function closeDialogVisuals(dialog) {
        if (dialog && dialog.parentNode) {
            dialog.remove();
        }
    }

    async function sha256(message) {
        const msgBuffer = new TextEncoder().encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function normalizeBackendUrl(url) {
        // If BACKEND_URL is relative (e.g. '') this won't modify absolute URLs.
        // If BACKEND_URL is absolute, it correctly strips it.
        if (BACKEND_URL && url.startsWith(BACKEND_URL)) {
            let relativeUrl = url.slice(BACKEND_URL.length);
            if (!relativeUrl.startsWith('/')) {
                relativeUrl = '/' + relativeUrl;
            }
            return relativeUrl;
        }
        return url;
    }

    function getUrlFromNode(node) {
        let current = node;
        while (current && current !== document.body) {
             // Special handling for review page source links
            if (current.nodeName === 'H3' && current.classList.contains('review-source-title')) {
                const child = current.querySelector('a.review-source-link');
                if (child && child.href) {
                    return normalizeBackendUrl(child.href);
                }
            }
            if (current.nodeName === 'A' && current.href) {
                if (current.href.startsWith(window.location.origin + '/#')) {
                    // Internal fragment link, prefer window.location.href
                } else if (current.href.startsWith('http')) {
                    return normalizeBackendUrl(current.href);
                }
            }
             // Handle traversing up from a paragraph on the review page
            if (current.classList && current.classList.contains('review-paragraph')) {
                let sibling = current.previousElementSibling;
                while(sibling) {
                    if (sibling.nodeName === 'H3' && sibling.classList.contains('review-source-title')) {
                        const link = sibling.querySelector('a.review-source-link');
                        if (link && link.href) return normalizeBackendUrl(link.href);
                        break;
                    }
                    sibling = sibling.previousElementSibling;
                }
            }
            current = current.parentNode;
        }
        return normalizeBackendUrl(window.location.href);
    }

    async function getContextFromNode(node) {
        try {
            let element = node.parentNode;
            const inlineTags = new Set(['SPAN', 'A', 'B', 'I', 'EM', 'STRONG', 'MARK', 'SUB', 'SUP', 'CODE']);
            while (element && element !== document.body && (inlineTags.has(element.nodeName) || !element.textContent?.trim())) {
                element = element.parentNode;
            }
            if (!element || element === document.body) {
                element = node.parentNode; // Fallback
            }

            // Remove known wrapper elements that might interfere with innerText
            element.querySelectorAll('.immersive-translate-target-wrapper').forEach(e => e.remove());

            const paragraphText = element.innerText?.trim() || node.textContent?.trim() || "";
            if (!paragraphText) {
                console.warn("Could not extract paragraph text.");
                return null;
            }

            const paragraphHash = await sha256(paragraphText);
            const nodeUrl = getUrlFromNode(node);
            const url = allowFragmentUrlList.some(prefix => nodeUrl.startsWith(prefix))
                ? nodeUrl
                : nodeUrl.split('#')[0];

            const urlHash = await sha256(url);
            const urlFragment = nodeUrl.includes('#') ? nodeUrl.split('#')[1] : null;
            const titleText = (document.title || "").trim();
            const finalTitle = urlFragment ? `${titleText} #${urlFragment}` : titleText;

            return {
                paragraphText: paragraphText,
                paragraphHash: paragraphHash,
                url: url,
                urlHash: urlHash,
                title: finalTitle || null,
            };
        } catch (e) {
            console.error("Error getting context:", e);
            return null;
        }
    }

    // --- Mutation Observer ---

    function setupMutationObserver() {
        if (typeof MutationObserver === "undefined") {
            console.warn("MutationObserver not available. Dynamic content updates may not be highlighted.");
            return;
        }
        mutationObserverInstance = new MutationObserver((mutations) => {
            let significantChange = false;
            for (const mutation of mutations) {
                if (mutation.target.closest && (mutation.target.closest('.lingomarker-dialog') || mutation.target.closest('.lingomarker-highlight'))) {
                    continue;
                }
                if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
                    // More refined check to avoid loops with some translation extensions
                    if (mutation.addedNodes.length > 0 && mutation.addedNodes[0].classList?.contains('notranslate')) continue;
                    if (mutation.removedNodes.length > 0 && mutation.removedNodes[0].classList?.contains('notranslate')) continue;

                    let isHighlightTextChange = false;
                    if (mutation.target.classList?.contains('lingomarker-highlight') && mutation.addedNodes.length === 1 && mutation.addedNodes[0].nodeType === Node.TEXT_NODE) {
                        isHighlightTextChange = true;
                    }
                    if (!isHighlightTextChange) {
                        significantChange = true;
                        break;
                    }
                } else if (mutation.type === 'characterData') {
                    if (!mutation.target.parentElement?.closest('.lingomarker-highlight')) {
                        significantChange = true;
                        break;
                    }
                }
            }

            if (significantChange && !isHighlighting && markInstance) { // Check markInstance
                safeApplyHighlights();
            }
        });
        observeMutations();
    }

    function observeMutations() {
        if (!mutationObserverInstance || !document.body) return;
        try {
            mutationObserverInstance.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        } catch (e) {
            console.error('Error connecting MutationObserver:', e);
        }
    }

    // --- Core Selection Logic ---
    async function handleSelectionLogic(selection, node) {
        if (!isAuthenticated || !selection || !node) return;

        const caption = selection.toString().trim().replace(/[.,?!"“”]/g, '');
        const word = caption.toLowerCase();

        if (!word || word.includes('\n') || selection.rangeCount === 0) return;
        const wordCount = word.split(/\s+/).filter(Boolean).length;
        if (wordCount === 0 || wordCount > wordsNumberLimit || word.length > wordsLengthLimit) {
            if (isDialogActive) {
                const dialog = document.querySelector('.lingomarker-dialog');
                if (dialog) closeDialogVisuals(dialog);
            }
            return;
        }

        const existingEntry = findEntryByWordForm(word);
        if (existingEntry) {
            if (isDialogActive) {
                const dialog = document.querySelector('.lingomarker-dialog');
                if (dialog) closeDialogVisuals(dialog);
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
            // Consider if selection should be cleared here.
            // if (window.getSelection) window.getSelection().removeAllRanges();
            return;
        }

        console.log(`New word selected: "${caption}". Preparing dialog.`);
        isDialogActive = true;

        showContextDialog(selection, caption, async () => {
            console.log(`Marking new word from dialog: "${caption}"`);
            const context = await getContextFromNode(node); // Use original node for context
            if (!context) {
                console.error("Failed to get context for selection (dialog callback).");
                alert("LingoMarker: Could not determine the context (paragraph/URL).");
                isDialogActive = false;
                return;
            }

            const transcriptSegmentRef = getTranscriptSegmentRef(node);

            try {
                const newEntry = await apiRequest('POST', '/api/mark', {
                    word: word,
                    url: context.url,
                    title: context.title,
                    paragraphText: context.paragraphText,
                    urlHash: context.urlHash,
                    paragraphHash: context.paragraphHash,
                    transcriptSegmentRef: transcriptSegmentRef,
                });
                console.log("Word marked successfully.", newEntry);

                if (newEntry && newEntry.uuid) {
                    // Update local cache (simplified)
                    // A full refresh might be safer or use a more robust cache update
                    await fetchUserDataAndHighlight(); // Refresh data and highlights
                } else {
                     await fetchUserDataAndHighlight(); // Fallback refresh
                }

            } catch (error) {
                console.error("Failed to mark word via API (dialog callback):", error);
                let errorMsg = "LingoMarker: Failed to save the word.";
                if (error.message?.includes("API key not configured")) errorMsg += " Please set your Gemini API key in the LingoMarker settings.";
                else if (error.message?.includes("Failed to retrieve word forms")) errorMsg += " Could not get word forms from the API.";
                else if (error.message?.includes("Unauthorized")) errorMsg = "LingoMarker: Authentication error. Please log in again.";
                alert(errorMsg);
            } finally {
                isDialogActive = false;
                if (window.getSelection) window.getSelection().removeAllRanges();
            }
        });
    }

    const debouncedHandleSelection = _.debounce(async () => {
        if (!isAuthenticated) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

        const node = selection.focusNode;
        if (!node) return;

        const range = selection.getRangeAt(0);
        const commonAncestor = range.commonAncestorContainer;
        let isInsideHighlight = false;
        if (commonAncestor) {
            if (commonAncestor.nodeType === Node.ELEMENT_NODE && commonAncestor.classList?.contains('lingomarker-highlight')) isInsideHighlight = true;
            else if (commonAncestor.parentElement?.closest('.lingomarker-highlight')) isInsideHighlight = true;
        }
        if (isInsideHighlight) {
            if (isDialogActive) {
                const dialog = document.querySelector('.lingomarker-dialog');
                if (dialog) closeDialogVisuals(dialog);
            }
            // if (window.getSelection) window.getSelection().removeAllRanges(); // Avoid clearing if user is adjusting selection
            return;
        }
        handleSelectionLogic(selection, node);
    }, 300);

    function handleMouseUpSelection() {
        const selection = window.getSelection();
        if (!isDialogActive && selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.toString().trim() !== '') {
            const node = selection.focusNode;
            if (!node) return;

            const range = selection.getRangeAt(0);
            const commonAncestor = range.commonAncestorContainer;
            let isInsideHighlight = false;
            if (commonAncestor) {
                 if (commonAncestor.nodeType === Node.ELEMENT_NODE && commonAncestor.classList?.contains('lingomarker-highlight')) isInsideHighlight = true;
                 else if (commonAncestor.parentElement?.closest('.lingomarker-highlight')) isInsideHighlight = true;
            }

            if (isInsideHighlight) {
                // Potentially clicked inside a highlight, which is handled by handleHighlightClick
                // Do not clear selection here as it might be an intended action for the highlight's click listener
            } else {
                handleSelectionLogic(selection, node);
            }
        }
    }

    // --- Event Listeners ---
    function setupEventListeners() {
        if (!touchScreen) {
            document.addEventListener('mouseup', handleMouseUpSelection);
        } else {
            document.addEventListener('selectionchange', debouncedHandleSelection);
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                console.log("Tab became visible, re-checking auth and data.");
                checkAuthAndFetchSettings().then(() => {
                    if (isAuthenticated && markInstance) { // Check markInstance
                        fetchUserDataAndHighlight();
                    } else if (markInstance) { // Check markInstance
                        safeApplyHighlights(); // Clear highlights if not authenticated
                    }
                });
            }
        });
    }

    // --- Exposed Helper for Import (Example) ---
    async function importLegacyData() {
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
            if (typeof parsedData !== 'object' || parsedData === null) {
                throw new Error("Invalid JSON structure.");
            }
            alert("Importing data... This may take a moment.");
            const result = await apiRequest('POST', '/api/import', parsedData);
            alert(`Import Complete!\nEntries: ${result.importedEntries}\nURLs: ${result.importedUrls}\nParagraphs: ${result.importedParagraphs}\nRelations: ${result.importedRelations}`);
            await fetchUserDataAndHighlight();
        } catch (error) {
            console.error("Import failed:", error);
            alert(`Import failed: ${error.message}`);
        }
    }

    // --- Public API ---
    const LingoMarker = {
        init: async function (config = {}) {
            // Example: Allow overriding BACKEND_URL if it were 'let' and passed in config
            // if (config.backendUrl) BACKEND_URL = config.backendUrl;

            // Ensure Lodash and Mark.js are available
            if (typeof _ === 'undefined') {
                console.error('LingoMarker Error: Lodash (_) is not loaded. Please include lodash.js before lingomarker.js.');
                return;
            }
            if (typeof Mark === 'undefined') {
                console.error('LingoMarker Error: Mark.js is not loaded. Please include mark.js before lingomarker.js.');
                return;
            }

            await initialize();
        },
        reloadData: async () => {
            if (!isAuthenticated) {
                console.warn("Cannot reload data: User not authenticated.");
                alert("Please log in to reload data.");
                return;
            }
            if (!markInstance) {
                 console.warn("Cannot reload data: Mark.js not initialized.");
                 return;
            }
            console.log("Reloading LingoMarker data via API call...");
            await fetchUserDataAndHighlight();
            alert("LingoMarker data reloaded.");
        },
        importData: importLegacyData, // Expose the import function
        // Add other functions you want to expose here
    };

    global.LingoMarker = LingoMarker;

})(window);