// ==UserScript==
// @name         Dan's TL;DR
// @namespace    http://tampermonkey.net/
// @version      0.20
// @description  Adds expand/collapse toggle, renders API summary as Markdown, respects Trusted Types, and includes a chat feature.
// @author       Your Name
// @match        *://*.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      yt-summarizer.lan
// @require      https://cdn.jsdelivr.net/npm/marked/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify/dist/purify.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CUSTOM_ELEMENT_ID = 'dans-tldr';
    const API_RESPONSE_AREA_ID = CUSTOM_ELEMENT_ID + '-response-area';
    const CONTENT_WRAPPER_ID = CUSTOM_ELEMENT_ID + '-content-wrapper';
    const TOGGLE_INDICATOR_ID = CUSTOM_ELEMENT_ID + '-toggle-indicator';
    const HEADING_CONTAINER_ID = CUSTOM_ELEMENT_ID + '-heading-container';
    const CHAT_CONTAINER_ID = CUSTOM_ELEMENT_ID + '-chat-container'; // New
    const CHAT_INPUT_ID = CUSTOM_ELEMENT_ID + '-chat-input'; // New
    const SEND_BUTTON_ID = CUSTOM_ELEMENT_ID + '-send-button'; // New
    const LOADING_INDICATOR_ID = CUSTOM_ELEMENT_ID + '-loading-indicator'; // New

    const PLAYER_SELECTOR = 'ytd-player';

    const LOG_PREFIX = "[Dan's TL;DR]";

    let resizeObserver = null;
    let playerHeightMutationObserver = null;
    let resizeListenerActive = false;
    let summaryGenerated = false;

    // Chat state
    let originalSummaryContent = ''; // Stores the initial summary for chat context
    let messageHistory = []; // Stores {role: 'user'|'assistant', content: 'markdown string'}

    let summaryHtmlPolicy = null;
    if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
        try {
            summaryHtmlPolicy = trustedTypes.createPolicy('youtubeSummaryMarkdown#html', {
                createHTML: (input) => {
                    return input;
                }
            });
        } catch (e) {
            console.warn(`${LOG_PREFIX} Could not create Trusted Types policy 'youtubeSummaryMarkdown#html'. HTML rendering might be restricted or fall back. Error: ${e.message}`);
        }
    } else {
        console.log(`${LOG_PREFIX} Trusted Types API not available.`);
    }

    function clearElementChildren(element) {
        if (!element) return;
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }

    function waitForElement(selector, callback, maxRetries = 20, interval = 500) {
        let retries = 0;
        const checkInterval = setInterval(() => {
            const element = document.querySelector(selector);
            if (element) {
                clearInterval(checkInterval);
                callback(element);
            } else {
                retries++;
                if (retries >= maxRetries) {
                    clearInterval(checkInterval);
                    console.log(`${LOG_PREFIX} Element not found after ${maxRetries} retries: ${selector}`);
                }
            }
        }, interval);
    }

    /**
     * Retries an async function 'fn' a specified number of times with a delay.
     * @param {Function} fn The async function to retry.
     * @param {number} maxRetries The maximum number of retry attempts (after the first try).
     * @param {number} delayMs The delay in milliseconds between retries.
     * @param {...any} args Arguments to pass to the function 'fn'.
     * @returns {Promise<any>} A Promise that resolves with the result of 'fn' or rejects after all retries fail.
     */
    async function retry(fn, maxRetries, delayMs, ...args) {
        let lastError;
        for (let i = 0; i <= maxRetries; i++) {
            try {
                console.log(`${LOG_PREFIX} Attempt ${i + 1}/${maxRetries + 1} to fetch data...`);
                return await fn(...args);
            } catch (error) {
                lastError = error;
                console.warn(`${LOG_PREFIX} Attempt ${i + 1} failed: ${error.message}`);
                if (i < maxRetries) {
                    console.log(`${LOG_PREFIX} Retrying in ${delayMs / 1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }
        throw lastError; // If all retries fail, throw the last error
    }

    function fetchSummaryViaGmXhr(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'http://yt-summarizer.lan/summarize',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ url: url }),
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            const data = JSON.parse(response.responseText);
                            resolve(data);
                        } catch (e) {
                            reject(new Error('Failed to parse API response: ' + e.message + "\nResponse: " + response.responseText));
                        }
                    } else {
                        reject(new Error(`API request failed with status ${response.status}: ${response.statusText} - ${response.responseText}`));
                    }
                },
                onerror: function (response) {
                    reject(new Error(`GM_xmlhttpRequest error: ${response.statusText || 'Network error'}. Details: ${response.error || 'N/A'}`));
                },
                ontimeout: function () {
                    reject(new Error('API request timed out.'));
                }
            });
        });
    }

    // New function for chat API
    function fetchChatResponseViaGmXhr(pageUrl, currentSummary, history) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'http://yt-summarizer.lan/ask',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    url: pageUrl,
                    original_summary: currentSummary,
                    history: history // This array includes user's latest question
                }),
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            const data = JSON.parse(response.responseText);
                            resolve(data);
                        } catch (e) {
                            reject(new Error('Failed to parse API response for chat: ' + e.message + "\nResponse: " + response.responseText));
                        }
                    } else {
                        reject(new Error(`Chat API request failed with status ${response.status}: ${response.statusText} - ${response.responseText}`));
                    }
                },
                onerror: function (response) {
                    reject(new Error(`GM_xmlhttpRequest error for chat: ${response.statusText || 'Network error'}. Details: ${response.error || 'N/A'}`));
                },
                ontimeout: function () {
                    reject(new Error('Chat API request timed out.'));
                }
            });
        });
    }

    async function fetchSummaryAndUpdateUI(pageUrl, responseAreaElement) {
        const chatInput = document.getElementById(CHAT_INPUT_ID);
        const sendButton = document.getElementById(SEND_BUTTON_ID);
        const chatContainer = document.getElementById(CHAT_CONTAINER_ID); // Get chat container

        // Reset chat elements and hide container
        if (chatInput) {
            chatInput.disabled = true;
            chatInput.placeholder = 'Summary not available to ask questions about.';
            chatInput.value = ''; // Clear any previous input
        }
        if (sendButton) sendButton.disabled = true;
        if (chatContainer) chatContainer.style.display = 'none'; // Hide chat container

        clearElementChildren(responseAreaElement);
        appendLoadingIndicator(responseAreaElement);
        // responseAreaElement.textContent = 'Loading Summary...';

        const RETRY_ATTEMPTS = 9;
        const RETRY_DELAY_MS = 1000;

        try {
            const data = await retry(fetchSummaryViaGmXhr, RETRY_ATTEMPTS, RETRY_DELAY_MS, pageUrl);

            clearElementChildren(responseAreaElement);

            if (data.summary && data.summary.trim() !== "") {
                originalSummaryContent = data.summary; // Store the original summary for chat
                messageHistory = []; // Reset message history for new summary

                marked.setOptions({
                    breaks: true,
                    gfm: true
                });
                const rawHtml = marked.parse(data.summary);
                const sanitizedHtmlString = DOMPurify.sanitize(rawHtml, {
                    USE_PROFILES: { html: true }
                });

                const tempRenderDiv = document.createElement('div');

                if (summaryHtmlPolicy) {
                    tempRenderDiv.innerHTML = summaryHtmlPolicy.createHTML(sanitizedHtmlString);
                } else {
                    console.warn(`${LOG_PREFIX} No Trusted Types policy available or creation failed. Attempting direct innerHTML or template fallback.`);
                    try {
                        tempRenderDiv.innerHTML = sanitizedHtmlString;
                    } catch (e) {
                        if (e.name === 'TypeError' && e.message.toLowerCase().includes("require 'trustedhtml'")) {
                            console.warn(`${LOG_PREFIX} Direct innerHTML assignment failed due to Trusted Types. Using template element fallback.`);
                            const template = document.createElement('template');
                            template.innerHTML = sanitizedHtmlString;
                            while (template.content.firstChild) {
                                tempRenderDiv.appendChild(template.content.firstChild);
                            }
                        } else {
                            throw e;
                        }
                    }
                }

                while (tempRenderDiv.firstChild) {
                    responseAreaElement.appendChild(tempRenderDiv.firstChild);
                }
                removeLoadingIndicator();
                summaryGenerated = true;

                // Enable and show chat input/button
                if (chatInput) {
                    chatInput.disabled = false;
                    chatInput.placeholder = 'Ask a question about the summary...';
                }
                if (sendButton) sendButton.disabled = false;
                if (chatContainer) chatContainer.style.display = 'flex'; // Show chat container

            } else {
                responseAreaElement.appendChild(document.createTextNode(data.summary ? "Summary is empty." : "No summary content received."));
                summaryGenerated = false;
                originalSummaryContent = ''; // Clear original summary
                messageHistory = []; // Clear chat history

                // Disable and hide chat input
                if (chatInput) {
                    chatInput.disabled = true;
                    chatInput.placeholder = 'Summary not available to ask questions about.';
                }
                if (sendButton) sendButton.disabled = true;
                if (chatContainer) chatContainer.style.display = 'none'; // Hide chat container
            }
            debouncedSetSummaryHeight();
        } catch (error) {
            console.error(`${LOG_PREFIX} API Error or rendering error after all retries:`, error);
            clearElementChildren(responseAreaElement); // Clear loading message

            const errorSpan = document.createElement('span');
            errorSpan.style.color = 'red';
            errorSpan.textContent = `Error: ${error.message}`;
            responseAreaElement.appendChild(errorSpan);

            const retryButton = document.createElement('button');
            retryButton.className = 'tldr-retry-button'; // Add a class for styling
            retryButton.textContent = 'Retry Summary';
            retryButton.addEventListener('click', async () => {
                await fetchSummaryAndUpdateUI(pageUrl, responseAreaElement);
            });
            responseAreaElement.appendChild(document.createElement('br'));
            responseAreaElement.appendChild(retryButton);

            summaryGenerated = false; // Reset flag on error so user can retry
            originalSummaryContent = ''; // Clear original summary
            messageHistory = []; // Clear chat history

            // Disable and hide chat input on error
            if (chatInput) {
                chatInput.disabled = true;
                chatInput.placeholder = 'Error fetching summary. Cannot ask questions.';
            }
            if (sendButton) sendButton.disabled = true;
            if (chatContainer) chatContainer.style.display = 'none'; // Hide chat container

            debouncedSetSummaryHeight();
        }
    }

    // New function to handle chat submission
    async function sendChatMessage() {
        const chatInput = document.getElementById(CHAT_INPUT_ID);
        const responseArea = document.getElementById(API_RESPONSE_AREA_ID);
        const currentVideoURL = window.location.href;

        if (!chatInput || !responseArea || !currentVideoURL || !originalSummaryContent) {
            console.warn(`${LOG_PREFIX} Chat elements or original summary not available. Original summary: "${originalSummaryContent}"`);
            return;
        }

        const userQuestion = chatInput.value.trim();
        if (!userQuestion) {
            return; // Don't send empty messages
        }

        // Add user question to history and display
        messageHistory.push({ role: 'user', content: userQuestion });
        appendChatMessageToUI(responseArea, `${userQuestion}`, 'user');

        chatInput.value = ''; // Clear input field
        chatInput.disabled = true; // Disable input while waiting for response
        const sendButton = document.getElementById(SEND_BUTTON_ID);
        if (sendButton) sendButton.disabled = true;

        appendLoadingIndicator(responseArea);

        try {
            const data = await retry(fetchChatResponseViaGmXhr, 3, 1000, currentVideoURL, originalSummaryContent, messageHistory);

            removeLoadingIndicator(); // Remove loading indicator

            if (data.answer && data.answer.trim() !== "") {
                messageHistory.push({ role: 'assistant', content: data.answer });
                appendChatMessageToUI(responseArea, `${data.answer}`, 'assistant');
            } else {
                appendChatMessageToUI(responseArea, 'AI did not provide an answer.', 'error');
            }
        } catch (error) {
            console.error(`${LOG_PREFIX} Chat API Error after retries:`, error);
            removeLoadingIndicator();
            appendChatMessageToUI(responseArea, `Error: ${error.message}`, 'error');
        } finally {
            chatInput.disabled = false;
            if (sendButton) sendButton.disabled = false;
            debouncedSetSummaryHeight(); // Recalculate height after new content
        }
    }

    // New function to append chat messages to UI
    function appendChatMessageToUI(responseArea, markdownContent, role) {
        // Add a horizontal rule for separation between original summary and chat, or between chat messages
        const hr = document.createElement('hr');
        hr.className = 'tldr-chat-separator';
        responseArea.appendChild(hr);

        marked.setOptions({
            breaks: true,
            gfm: true
        });
        const rawHtml = marked.parse(markdownContent);
        const sanitizedHtmlString = DOMPurify.sanitize(rawHtml, {
            USE_PROFILES: { html: true }
        });

        const tempRenderDiv = document.createElement('div');
        tempRenderDiv.className = `tldr-chat-message tldr-chat-message-${role}`; // Add class for styling

        if (summaryHtmlPolicy) {
            tempRenderDiv.innerHTML = summaryHtmlPolicy.createHTML(sanitizedHtmlString);
        } else {
            try {
                tempRenderDiv.innerHTML = sanitizedHtmlString;
            } catch (e) {
                if (e.name === 'TypeError' && e.message.toLowerCase().includes("require 'trustedhtml'")) {
                    const template = document.createElement('template');
                    template.innerHTML = sanitizedHtmlString;
                    while (template.content.firstChild) {
                        tempRenderDiv.appendChild(template.content.firstChild);
                    }
                } else {
                    throw e;
                }
            }
        }
        responseArea.appendChild(tempRenderDiv);
        responseArea.scrollTop = responseArea.scrollHeight; // Scroll to bottom
    }

    let loadingIndicator = null;
    function appendLoadingIndicator(responseArea) {
        if (!loadingIndicator) {
            loadingIndicator = document.createElement('div');
            loadingIndicator.id = LOADING_INDICATOR_ID;
            loadingIndicator.textContent = '';
            loadingIndicator.classList.add('tldr-loading-spinner');
        }
        responseArea.appendChild(loadingIndicator);
        responseArea.scrollTop = responseArea.scrollHeight;
    }

    function removeLoadingIndicator() {
        if (loadingIndicator && loadingIndicator.parentNode) {
            loadingIndicator.parentNode.removeChild(loadingIndicator);
            loadingIndicator.classList.remove('tldr-loading-spinner'); // Clean up class
            loadingIndicator = null;
        }
    }

    function debounce(func, delay) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func.apply(this, args), delay);
        };
    }

    function setSummaryHeight() {
        const playerElement = document.querySelector(PLAYER_SELECTOR);
        const responseArea = document.getElementById(API_RESPONSE_AREA_ID);
        const customElement = document.getElementById(CUSTOM_ELEMENT_ID);
        const headingContainer = document.getElementById(HEADING_CONTAINER_ID);
        const contentWrapper = document.getElementById(CONTENT_WRAPPER_ID);

        // Only calculate height if custom element is visible (expanded)
        if (!playerElement || !responseArea || !customElement || !headingContainer || !contentWrapper || contentWrapper.style.display === 'none') {
            return;
        }

        const playerHeight = playerElement.offsetHeight;

        let spaceUsedByHeader = 0;
        spaceUsedByHeader += headingContainer.offsetHeight;
        spaceUsedByHeader += parseFloat(getComputedStyle(headingContainer).marginBottom);

        const customElementStyle = getComputedStyle(customElement);
        const customElementPaddingTop = parseFloat(customElementStyle.paddingTop);
        const customElementPaddingBottom = parseFloat(customElementStyle.paddingBottom);
        const customElementBorderTop = parseFloat(customElementStyle.borderTopWidth);
        const customElementBorderBottom = parseFloat(customElementStyle.borderBottomWidth);

        // Account for response area's top margin (if any, as it was removed from CSS)
        const responseAreaStyle = getComputedStyle(responseArea);
        const responseAreaMarginTop = parseFloat(responseAreaStyle.marginTop);

        // Calculate height of chat container and its margins/padding
        const chatContainer = document.getElementById(CHAT_CONTAINER_ID);
        let chatContainerTotalHeight = 0;
        if (chatContainer && chatContainer.style.display !== 'none') { // Only count if chat is visible
            const chatContainerStyle = getComputedStyle(chatContainer);
            chatContainerTotalHeight = chatContainer.offsetHeight;
            // Add any top margin/padding that might exist outside the offsetHeight
            chatContainerTotalHeight += parseFloat(chatContainerStyle.marginTop);
            chatContainerTotalHeight += parseFloat(chatContainerStyle.marginBottom);
            chatContainerTotalHeight += parseFloat(chatContainerStyle.paddingTop);
            chatContainerTotalHeight += parseFloat(chatContainerStyle.paddingBottom);
            chatContainerTotalHeight += parseFloat(chatContainerStyle.borderTopWidth);
            chatContainerTotalHeight += parseFloat(chatContainerStyle.borderBottomWidth);
        }

        // Total non-scrolling vertical space within the custom element (excluding the response area's height)
        // This includes custom element's padding/border, heading, response area's top margin, AND chat container's full height
        const nonScrollingContentHeight = spaceUsedByHeader + customElementPaddingTop + customElementPaddingBottom +
            customElementBorderTop + customElementBorderBottom + responseAreaMarginTop +
            chatContainerTotalHeight; // Add chat container's full height

        const buffer = 10;
        const calculatedMaxHeight = playerHeight - nonScrollingContentHeight - buffer;

        responseArea.style.maxHeight = `${Math.max(50, calculatedMaxHeight)}px`;
        responseArea.style.overflowY = 'auto';
        responseArea.style.boxSizing = 'border-box';
        responseArea.style.width = '100%';
    }

    const debouncedSetSummaryHeight = debounce(setSummaryHeight, 250);

    function observePlayerForHeightChanges() {
        cleanupObservers();

        waitForElement(PLAYER_SELECTOR, (playerElement) => {
            debouncedSetSummaryHeight();

            if (typeof ResizeObserver !== 'undefined') {
                resizeObserver = new ResizeObserver(entries => {
                    if (entries.some(entry => entry.target === playerElement)) {
                        debouncedSetSummaryHeight();
                    }
                });
                resizeObserver.observe(playerElement);
            } else {
                waitForElement('ytd-watch-flexy', (flexyElement) => {
                    playerHeightMutationObserver = new MutationObserver(mutations => {
                        let shouldUpdateHeight = false;
                        for (let mutation of mutations) {
                            if (mutation.type === 'attributes' && (mutation.attributeName === 'theater' || mutation.attributeName === 'is-fullscreen')) {
                                shouldUpdateHeight = true;
                                break;
                            }
                            if (mutation.type === 'childList' && (mutation.target.id === 'primary' || mutation.target.id === 'secondary' || mutation.target.id === 'player-container')) {
                                shouldUpdateHeight = true;
                                break;
                            }
                        }
                        if (shouldUpdateHeight) {
                            debouncedSetSummaryHeight();
                        }
                    });
                    playerHeightMutationObserver.observe(flexyElement, {
                        attributes: true,
                        attributeFilter: ['theater', 'is-fullscreen'],
                        childList: true,
                        subtree: true
                    });
                });
            }

            window.addEventListener('resize', debouncedSetSummaryHeight);
            resizeListenerActive = true;
        }, 40, 250);
    }

    function cleanupObservers() {
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        if (playerHeightMutationObserver) {
            playerHeightMutationObserver.disconnect();
            playerHeightMutationObserver = null;
        }
        if (resizeListenerActive) {
            window.removeEventListener('resize', debouncedSetSummaryHeight);
            resizeListenerActive = false;
        }
    }


    function injectCustomElement() {
        if (document.getElementById(CUSTOM_ELEMENT_ID)) {
            console.log(`${LOG_PREFIX} Custom element already exists. No new injection needed.`);
            return;
        }

        const referenceNodeSelector = 'ytd-watch-next-secondary-results-renderer';

        waitForElement(referenceNodeSelector, (referenceNode) => {
            if (document.getElementById(CUSTOM_ELEMENT_ID)) {
                return;
            }

            const parentElement = referenceNode.parentNode;

            if (!parentElement) {
                console.error(`${LOG_PREFIX} Could not find parent of reference node '${referenceNodeSelector}'. Aborting injection.`);
                return;
            }

            const customElement = document.createElement('div');
            customElement.id = CUSTOM_ELEMENT_ID;
            customElement.setAttribute('data-is-expanded', 'false');

            const headingContainer = document.createElement('div');
            headingContainer.id = HEADING_CONTAINER_ID;

            const heading = document.createElement('h3');
            heading.textContent = "Dan's TL;DR";

            const toggleIndicator = document.createElement('span');
            toggleIndicator.id = TOGGLE_INDICATOR_ID;
            toggleIndicator.textContent = '+';

            headingContainer.appendChild(heading);
            headingContainer.appendChild(toggleIndicator);
            customElement.appendChild(headingContainer);

            const contentWrapper = document.createElement('div');
            contentWrapper.id = CONTENT_WRAPPER_ID;
            contentWrapper.style.display = 'none'; // Hide content initially

            const responseArea = document.createElement('div');
            responseArea.id = API_RESPONSE_AREA_ID;
            contentWrapper.appendChild(responseArea);

            // --- New Chat Elements ---
            const chatContainer = document.createElement('div');
            chatContainer.id = CHAT_CONTAINER_ID;
            chatContainer.style.display = 'none'; // Initially hidden until summary is loaded

            const chatInput = document.createElement('input');
            chatInput.id = CHAT_INPUT_ID;
            chatInput.placeholder = 'Summary not available to ask questions about.';
            chatInput.rows = 3;
            chatInput.disabled = true; // Initially disabled until summary is loaded

            const sendButton = document.createElement('button');
            sendButton.id = SEND_BUTTON_ID;
            sendButton.textContent = 'Send';
            sendButton.className = 'tldr-chat-button';
            sendButton.disabled = true; // Initially disabled

            chatContainer.appendChild(chatInput);
            chatContainer.appendChild(sendButton);
            contentWrapper.appendChild(chatContainer);
            // --- End New Chat Elements ---

            customElement.appendChild(contentWrapper);

            headingContainer.addEventListener('click', () => {
                const isExpanded = customElement.getAttribute('data-is-expanded') === 'true';
                if (isExpanded) {
                    contentWrapper.style.display = 'none';
                    customElement.setAttribute('data-is-expanded', 'false');
                    toggleIndicator.textContent = '+';
                } else {
                    contentWrapper.style.display = 'block';
                    customElement.setAttribute('data-is-expanded', 'true');
                    toggleIndicator.textContent = '-';

                    if (!summaryGenerated) {
                        const currentVideoURL = window.location.href;
                        if (currentVideoURL.includes('/watch?v=')) {
                            const responseAreaElem = document.getElementById(API_RESPONSE_AREA_ID);
                            if (responseAreaElem) {
                                fetchSummaryAndUpdateUI(currentVideoURL, responseAreaElem);
                            }
                        } else {
                            const responseAreaElem = document.getElementById(API_RESPONSE_AREA_ID);
                            const chatInputElem = document.getElementById(CHAT_INPUT_ID);
                            const sendButtonElem = document.getElementById(SEND_BUTTON_ID);
                            const chatContainerElem = document.getElementById(CHAT_CONTAINER_ID); // Get chat container

                            if (responseAreaElem) {
                                clearElementChildren(responseAreaElem);
                                const orangeSpan = document.createElement('span');
                                orangeSpan.style.color = 'orange';
                                orangeSpan.textContent = 'Not a valid video watch page.';
                                responseAreaElem.appendChild(orangeSpan);
                            }
                            // Also disable/hide chat input if not on a watch page
                            if (chatInputElem) {
                                chatInputElem.disabled = true;
                                chatInputElem.placeholder = 'Not a video page.';
                                chatInputElem.value = '';
                            }
                            if (sendButtonElem) sendButtonElem.disabled = true;
                            if (chatContainerElem) chatContainerElem.style.display = 'none'; // Hide chat container
                        }
                    }
                }
                debouncedSetSummaryHeight();
            });

            // Add event listeners for chat input and send button
            sendButton.addEventListener('click', sendChatMessage);
            chatInput.addEventListener('keypress', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) { // Enter without Shift
                    event.preventDefault(); // Prevent new line in textarea
                    sendChatMessage();
                }
            });


            parentElement.insertBefore(customElement, referenceNode);
            console.log(`${LOG_PREFIX} Custom element with ID ${CUSTOM_ELEMENT_ID} injected into the right sidebar.`);

            observePlayerForHeightChanges();
        }, 40, 250);
    }

    GM_addStyle(`
        #${CUSTOM_ELEMENT_ID} {
            border: 2px solid #444444;
            padding: 10px;
            margin: 0 0 10px 0;
            background-color: #2a2a2a;
            border-radius: 8px;
            color: #e0e0e0;
            font-size: 16px;
            box-sizing: border-box;
            width: 100%;
        }

        #${HEADING_CONTAINER_ID} {
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            padding-bottom: 8px;
            border-bottom: 1px solid #555555;
            margin-bottom: 8px;
        }

        #${HEADING_CONTAINER_ID} h3 {
            margin: 0;
            color: #f0f0f0;
            font-size: 1.1em;
        }

        #${TOGGLE_INDICATOR_ID} {
            font-size: 1.2em;
            font-weight: bold;
            color: #cccccc;
        }

        .tldr-retry-button {
            background-color: #555555;
            border: 1px solid #666666;
            color: #f0f0f0;
            padding: 8px 15px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 14px;
            cursor: pointer;
            border-radius: 4px;
            transition: background-color 0.3s ease, border-color 0.3s ease;
            margin-top: 10px;
        }

        .tldr-retry-button:hover {
            background-color: #666666;
            border-color: #777777;
        }


        #${API_RESPONSE_AREA_ID} {
            color: #cccccc;
            border-radius: 4px;
            font-size: 0.9em;
            line-height: 1.4;
            word-wrap: break-word;
            min-height: 30px;
            overflow-y: auto;
            box-sizing: border-box;
            width: 100%;
        }

        #${API_RESPONSE_AREA_ID} strong {
            color: #f0f0f0;
            font-weight: bold;
        }

        /* Markdown specific styles */
        #${API_RESPONSE_AREA_ID} p {
            margin-top: 0.5em;
            margin-bottom: 0.5em;
        }
        #${API_RESPONSE_AREA_ID} h1, #${API_RESPONSE_AREA_ID} h2, #${API_RESPONSE_AREA_ID} h3,
        #${API_RESPONSE_AREA_ID} h4, #${API_RESPONSE_AREA_ID} h5, #${API_RESPONSE_AREA_ID} h6 {
            color: #e8e8e8;
            margin-top: 1em;
            margin-bottom: 0.5em;
            border-bottom: 1px solid #4a4a4a;
            padding-bottom: 0.2em;
        }
        #${API_RESPONSE_AREA_ID} h1 { font-size: 1.5em; }
        #${API_RESPONSE_AREA_ID} h2 { font-size: 1.3em; }
        #${API_RESPONSE_AREA_ID} h3 { font-size: 1.15em; }

        #${API_RESPONSE_AREA_ID} ul, #${API_RESPONSE_AREA_ID} ol {
            margin-left: 20px;
            padding-left: 10px;
        }
        #${API_RESPONSE_AREA_ID} li {
            margin-bottom: 0.3em;
        }

        #${API_RESPONSE_AREA_ID} code {
            background-color: #383838;
            padding: 2px 5px;
            border-radius: 4px;
            font-family: Consolas, Monaco, 'Andale Mono', 'Ubuntu Mono', monospace;
            font-size: 0.9em;
            color: #d0d0d0;
        }
        #${API_RESPONSE_AREA_ID} pre {
            background-color: #111111;
            border: 1px solid #3a3a3a;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 10px 0;
        }
        #${API_RESPONSE_AREA_ID} pre code {
            background-color: transparent;
            padding: 0;
            border: none;
            font-size: 1em;
        }

        #${API_RESPONSE_AREA_ID} blockquote {
            border-left: 4px solid #555555;
            padding-left: 15px;
            margin-left: 0;
            color: #b0b0b0;
            font-style: italic;
        }
        #${API_RESPONSE_AREA_ID} table {
            border-collapse: collapse;
            width: 100%;
            margin: 1em 0;
        }
        #${API_RESPONSE_AREA_ID} th, #${API_RESPONSE_AREA_ID} td {
            border: 1px solid #4a4a4a;
            padding: 8px;
            text-align: left;
        }
        #${API_RESPONSE_AREA_ID} th {
            background-color: #3a3a3a;
        }
        #${API_RESPONSE_AREA_ID} a {
            color: #58a6ff;
            text-decoration: none;
        }
        #${API_RESPONSE_AREA_ID} a:hover {
            text-decoration: underline;
        }
        #${API_RESPONSE_AREA_ID} hr {
            border: 0;
            border-top: 1px solid #4a4a4a;
            margin: 1em 0;
        }

        /* NEW CHAT STYLES */
        #${CHAT_CONTAINER_ID} {
            margin-top: 15px;
            padding-top: 10px;
            border-top: 1px solid #555555; /* Separator for chat */
            display: flex;
            flex-direction: row; /* Changed to row for single line */
            gap: 10px; /* Space between input and button */
            align-items: flex-end; /* Align items to the bottom, useful for multi-line textarea */
        }

        #${CHAT_INPUT_ID} {
            background-color: #333333;
            border: 1px solid #555555;
            color: #e0e0e0;
            padding: 8px 10px;
            border-radius: 4px;
            font-size: 0.9em;
            flex-grow: 1; /* Makes it take up available space */
            box-sizing: border-box; /* Include padding/border in width */
            font-family: inherit; /* Use page's font family */
            resize: vertical; /* Allow vertical resizing, but not horizontal */
            min-height: 38px; /* Ensure enough height for one line + padding, adjusted for button height */
        }

        #${CHAT_INPUT_ID}:focus {
            outline: none;
            border-color: #77b0ff; /* Highlight on focus */
            box-shadow: 0 0 0 2px rgba(119, 176, 255, 0.3);
        }

        .tldr-chat-button {
            background-color: #007bff; /* Primary blue for send button */
            border: 1px solid #007bff;
            color: white;
            padding: 8px 15px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 14px;
            cursor: pointer;
            border-radius: 4px;
            transition: background-color 0.3s ease, border-color 0.3s ease;
            /* Removed align-self: flex-end; as container handles alignment now */
            height: fit-content; /* Make button height fit content */
        }

        .tldr-chat-button:hover {
            background-color: #0056b3;
            border-color: #0056b3;
        }

        .tldr-chat-button:disabled {
            background-color: #555555;
            border-color: #555555;
            cursor: not-allowed;
            opacity: 0.7;
        }

        .tldr-chat-message {
            /* Margin between messages within the response area is handled by hr */
        }

        .tldr-chat-message-user {
            text-align: right;
            color: #cccccc;
        }

        .tldr-chat-message-assistant {
            text-align: left;
            color: #cccccc;
        }

        .tldr-chat-message-error {
            color: red; /* Red for error messages */
            font-weight: bold;
        }

        .tldr-chat-separator {
            border: 0;
            border-top: 1px dashed #666666; /* Dashed line for chat separation */
            margin: 1em 0; /* Space around the separator */
        }

        #${LOADING_INDICATOR_ID} {
            font-weight: bold;
            font-size: 3em;
            color: #cccccc;
            text-align: center;
         }

         /* Spinner Animation for Loading Indicator */
         @keyframes tldr-dot-spinner {
             0%, 100% { content: '·..'; }
             15% { content: '··.'; }
             30% { content: '···'; }
             45% { content: '.··'; }
             60% { content: '..·'; }
             75% { content: '...'; }
         }

         .tldr-loading-spinner::after {
             content: '...';
             display: inline-block;
             vertical-align: bottom;
             animation: tldr-dot-spinner 1.5s infinite steps(6, end);
         }
    `);

    let lastUrl = '';

    function initialize() {
        console.log(`${LOG_PREFIX} Script initialized. Current URL: ${window.location.href}`);
        lastUrl = location.href;

        // Ensure proper state when script first runs based on current URL
        if (lastUrl.includes("/watch")) {
            injectCustomElement();
        } else {
            const oldElement = document.getElementById(CUSTOM_ELEMENT_ID);
            if (oldElement) {
                oldElement.remove();
                cleanupObservers();
                summaryGenerated = false;
                originalSummaryContent = ''; // Clear original summary
                messageHistory = []; // Clear chat history
                removeLoadingIndicator(); // Ensure no loading indicator is left
                console.log(`${LOG_PREFIX} Removed custom element as started on non-watch page.`);
            }
        }

        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                console.log(`${LOG_PREFIX} URL changed from ${lastUrl} to ${url}.`);
                lastUrl = url;

                const chatInput = document.getElementById(CHAT_INPUT_ID);
                const sendButton = document.getElementById(SEND_BUTTON_ID);
                const chatContainer = document.getElementById(CHAT_CONTAINER_ID);

                if (url.includes("/watch")) {
                    const existingElement = document.getElementById(CUSTOM_ELEMENT_ID);
                    if (existingElement) {
                        const responseArea = document.getElementById(API_RESPONSE_AREA_ID);
                        const contentWrapper = document.getElementById(CONTENT_WRAPPER_ID);
                        const toggleIndicator = document.getElementById(TOGGLE_INDICATOR_ID);

                        if (responseArea && contentWrapper && toggleIndicator) {
                            clearElementChildren(responseArea);
                            summaryGenerated = false;
                            originalSummaryContent = ''; // Clear original summary
                            messageHistory = []; // Clear chat history

                            existingElement.setAttribute('data-is-expanded', 'false');
                            contentWrapper.style.display = 'none';
                            toggleIndicator.textContent = '+';

                            // Clear and reset chat input/button/container
                            if (chatInput) {
                                chatInput.value = '';
                                chatInput.disabled = true; // Disable until new summary
                                chatInput.placeholder = 'Summary not available to ask questions about.';
                            }
                            if (sendButton) sendButton.disabled = true; // Disable until new summary
                            if (chatContainer) chatContainer.style.display = 'none'; // Hide until new summary

                            removeLoadingIndicator(); // Ensure no loading indicator is left

                            console.log(`${LOG_PREFIX} Reset content of existing element for new video page.`);
                            // We need to re-fetch summary when expanded again, not immediately
                            // Also need to re-observe player for height on new page
                            observePlayerForHeightChanges();
                        }
                    } else {
                        // Element doesn't exist, inject it for the new watch page
                        setTimeout(() => {
                            injectCustomElement();
                        }, 500); // Small delay to allow YouTube's DOM to settle
                    }
                } else {
                    const oldElement = document.getElementById(CUSTOM_ELEMENT_ID);
                    if (oldElement) {
                        oldElement.remove();
                        cleanupObservers();
                        summaryGenerated = false;
                        originalSummaryContent = ''; // Clear original summary
                        messageHistory = []; // Clear chat history
                        removeLoadingIndicator(); // Ensure no loading indicator is left
                        console.log(`${LOG_PREFIX} Removed custom element as navigated away from watch page.`);
                    }
                }
            }
        }).observe(document.body, { subtree: true, childList: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize);
    } else {
        initialize();
    }
})();