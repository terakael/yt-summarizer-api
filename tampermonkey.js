// ==UserScript==
// @name         Dan's TL;DR (Streaming Edition)
// @namespace    http://tampermonkey.net/
// @version      0.21
// @description  Adds expand/collapse toggle, renders API summary as Markdown (streaming), respects Trusted Types, and includes a streaming chat feature.
// @author       Your Name / AI Assistant
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
    const CHAT_CONTAINER_ID = CUSTOM_ELEMENT_ID + '-chat-container';
    const CHAT_INPUT_ID = CUSTOM_ELEMENT_ID + '-chat-input';
    const SEND_BUTTON_ID = CUSTOM_ELEMENT_ID + '-send-button';
    const LOADING_INDICATOR_ID = CUSTOM_ELEMENT_ID + '-loading-indicator';
    const PLAYER_SELECTOR = 'ytd-player';
    const LOG_PREFIX = "[Dan's TL;DR]";

    const SUMMARY_CONTENT_ID = CUSTOM_ELEMENT_ID + '-summary-content'; // For the summary itself

    let resizeObserver = null;
    let playerHeightMutationObserver = null;
    let resizeListenerActive = false;
    let summaryGenerated = false;
    let originalSummaryContent = '';
    let messageHistory = [];
    let summaryHtmlPolicy = null;

    let currentSummaryXhr = null; // To store and potentially abort summary XHR
    let currentChatXhr = null;   // To store and potentially abort chat XHR

    if (typeof trustedTypes !== 'undefined' && trustedTypes.createPolicy) {
        try {
            summaryHtmlPolicy = trustedTypes.createPolicy('youtubeSummaryMarkdown#html', {
                createHTML: (input) => input
            });
        } catch (e) {
            console.warn(`${LOG_PREFIX} Could not create Trusted Types policy. Error: ${e.message}`);
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
        // ... (keep existing implementation)
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

    // Removed old retry function as streaming handles retries/errors differently via UI

    // --- START: SSE Streaming Logic ---
    function SseParser() {
        let buffer = '';
        this.parse = function* (chunk) {
            buffer += chunk;
            let eventData = { type: 'message', dataLines: [] };
            while (true) {
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex === -1) break;
                const line = buffer.substring(0, newlineIndex);
                buffer = buffer.substring(newlineIndex + 1);
                if (line === '') {
                    if (eventData.dataLines.length > 0) {
                        const fullData = eventData.dataLines.join('\n');
                        try {
                            yield { type: eventData.type, data: JSON.parse(fullData) };
                        } catch (e) {
                            yield { type: eventData.type, data: { raw: fullData, error: "Not JSON" } };
                        }
                    }
                    eventData = { type: 'message', dataLines: [] };
                    continue;
                }
                if (line.startsWith('event:')) {
                    eventData.type = line.substring('event:'.length).trim();
                } else if (line.startsWith('data:')) {
                    eventData.dataLines.push(line.substring('data:'.length).trim());
                }
            }
        };
    }

    function streamRequestGmXhr({ url, method, data, onMetadata, onDataChunk, onErrorEvent, onStreamEnd, onXHRError, onXHRTimeout, onXHRLoadEnd }) {
        let sseParser = new SseParser();
        let lastProcessedLength = 0;
        const xhr = GM_xmlhttpRequest({
            method: method,
            url: url,
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            data: data ? JSON.stringify(data) : null,
            responseType: 'stream',
            onloadstart: async function (r) {
                const decoder = new TextDecoder('utf-8');

                const reader = r.response.getReader();
                while (true) {
                    const { done, value } = await reader.read(); // value is Uint8Array
                    if (value) {
                        const chunkString = decoder.decode(value, { stream: true });
                        for (const sseEvent of sseParser.parse(chunkString)) {
                            if (sseEvent.type === 'metadata' && onMetadata) onMetadata(sseEvent.data);
                            else if (sseEvent.type === 'error' && onErrorEvent) onErrorEvent(sseEvent.data);
                            else if (sseEvent.type === 'stream_end' && onStreamEnd) onStreamEnd(sseEvent.data);
                            else if ((sseEvent.type === 'message' || sseEvent.type === 'data') && onDataChunk) {
                                if (sseEvent.data && typeof sseEvent.data.chunk !== 'undefined') {
                                    onDataChunk(sseEvent.data);
                                } else {
                                    console.warn(`${LOG_PREFIX} Received data event without 'chunk':`, sseEvent);
                                }
                            }
                        }

                        console.log(chunkString, 'received')
                    }
                    if (done) {
                        onXHRLoadEnd(r)
                        break; // Exit the loop
                    }
                }
                console.log('done');
            }
        });
        // const xhr = GM_xmlhttpRequest({
        //     method: method,
        //     url: url,
        //     headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        //     data: data ? JSON.stringify(data) : null,
        //     responseType: 'text',
        //     onreadystatechange: function (event) {
        //         if (event.readyState >= 3) { // LOADING or DONE
        //             const newText = event.responseText.substring(lastProcessedLength);
        //             lastProcessedLength = event.responseText.length;
        //             if (newText) {
        //                 for (const sseEvent of sseParser.parse(newText)) {
        //                     if (sseEvent.type === 'metadata' && onMetadata) onMetadata(sseEvent.data);
        //                     else if (sseEvent.type === 'error' && onErrorEvent) onErrorEvent(sseEvent.data);
        //                     else if (sseEvent.type === 'stream_end' && onStreamEnd) onStreamEnd(sseEvent.data);
        //                     else if ((sseEvent.type === 'message' || sseEvent.type === 'data') && onDataChunk) {
        //                         if (sseEvent.data && typeof sseEvent.data.chunk !== 'undefined') {
        //                             onDataChunk(sseEvent.data);
        //                         } else {
        //                             console.warn(`${LOG_PREFIX} Received data event without 'chunk':`, sseEvent);
        //                         }
        //                     }
        //                 }
        //             }
        //         }
        //         if (event.readyState === 4 && onXHRLoadEnd) onXHRLoadEnd(event);
        //     },
        //     onload: function (response) { /* onreadystatechange handles readyState 4 */ },
        //     onerror: function (response) { if (onXHRError) onXHRError(response); },
        //     ontimeout: function () { if (onXHRTimeout) onXHRTimeout(); }
        // });
        return xhr;
    }
    // --- END: SSE Streaming Logic ---


    // Helper to render markdown safely into an element
    function renderMarkdownToElement(element, markdownContent) {
        clearElementChildren(element);
        marked.setOptions({ breaks: true, gfm: true });
        const rawHtml = marked.parse(markdownContent || "");
        const sanitizedHtmlString = DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
        if (summaryHtmlPolicy) {
            element.innerHTML = summaryHtmlPolicy.createHTML(sanitizedHtmlString);
        } else {
            try { element.innerHTML = sanitizedHtmlString; }
            catch (e) {
                if (e.name === 'TypeError' && e.message.toLowerCase().includes("require 'trustedhtml'")) {
                    const template = document.createElement('template');
                    template.innerHTML = sanitizedHtmlString;
                    while (template.content.firstChild) element.appendChild(template.content.firstChild);
                } else { throw e; }
            }
        }
    }

    // Helper to parse JSON error from responseText or return snippet
    function tryParseError(responseText) {
        try {
            const errJson = JSON.parse(responseText);
            return errJson.error || responseText;
        } catch (e) {
            return responseText.substring(0, 200) + (responseText.length > 200 ? "..." : "");
        }
    }

    // Helper to append a retry button
    function appendRetryButton(parentElement, ...retryArgs) { // Last arg is the retryCallback
        const retryCallback = retryArgs.pop();
        const retryButton = document.createElement('button');
        retryButton.className = 'tldr-retry-button';
        retryButton.textContent = 'Retry';
        retryButton.addEventListener('click', async () => {
            await retryCallback(...retryArgs);
        });
        const br = parentElement.querySelector('br.retry-spacer');
        if (!br) {
            const newBr = document.createElement('br');
            newBr.className = 'retry-spacer';
            parentElement.appendChild(newBr);
        }
        // Remove existing retry button before adding new one if any
        const existingRetry = parentElement.querySelector('.tldr-retry-button');
        if (existingRetry) existingRetry.remove();

        parentElement.appendChild(retryButton);
    }

    async function fetchSummaryAndUpdateUI(pageUrl, responseAreaElement) {
        const chatInput = document.getElementById(CHAT_INPUT_ID);
        const sendButton = document.getElementById(SEND_BUTTON_ID);
        const chatContainer = document.getElementById(CHAT_CONTAINER_ID);

        if (currentSummaryXhr && typeof currentSummaryXhr.abort === 'function') {
            currentSummaryXhr.abort();
            console.log(`${LOG_PREFIX} Aborted previous summary request.`);
        }
        currentSummaryXhr = null;

        if (chatInput) { chatInput.disabled = true; chatInput.placeholder = 'Loading summary...'; chatInput.value = ''; }
        if (sendButton) sendButton.disabled = true;
        if (chatContainer) chatContainer.style.display = 'none';

        clearElementChildren(responseAreaElement);
        const summaryContentDiv = document.createElement('div');
        summaryContentDiv.id = SUMMARY_CONTENT_ID;
        responseAreaElement.appendChild(summaryContentDiv);
        appendLoadingIndicator(summaryContentDiv);

        originalSummaryContent = '';
        messageHistory = [];
        summaryGenerated = false;
        let accumulatedSummary = '';
        let streamEndedSuccessfully = false;

        console.log(`${LOG_PREFIX} Starting summary stream for ${pageUrl}`);
        currentSummaryXhr = streamRequestGmXhr({
            url: 'http://yt-summarizer.lan/summarize',
            method: 'POST',
            data: { url: pageUrl },
            onMetadata: (data) => { /* console.log(`${LOG_PREFIX} Summary metadata:`, data); */ },
            onDataChunk: (data) => {
                removeLoadingIndicator(); // Remove once first chunk arrives
                accumulatedSummary += data.chunk;
                renderMarkdownToElement(summaryContentDiv, accumulatedSummary);
                responseAreaElement.scrollTop = responseAreaElement.scrollHeight;
            },
            onErrorEvent: (errorData) => {
                console.error(`${LOG_PREFIX} SSE Error (Summary):`, errorData);
                removeLoadingIndicator();
                renderMarkdownToElement(summaryContentDiv, `**Stream Error:** ${errorData.error || 'Unknown stream error'}`);
                if (chatInput) chatInput.placeholder = 'Error loading summary.';
                appendRetryButton(summaryContentDiv, pageUrl, responseAreaElement, fetchSummaryAndUpdateUI);
            },
            onStreamEnd: () => {
                console.log(`${LOG_PREFIX} Summary stream ended.`);
                streamEndedSuccessfully = true;
                removeLoadingIndicator();
                if (accumulatedSummary.trim() === "") {
                    renderMarkdownToElement(summaryContentDiv, "Summary is empty or not available.");
                } else {
                    originalSummaryContent = accumulatedSummary;
                    summaryGenerated = true;
                    if (chatInput) { chatInput.disabled = false; chatInput.placeholder = 'Ask a question about the summary...'; }
                    if (sendButton) sendButton.disabled = false;
                    if (chatContainer) chatContainer.style.display = 'flex';
                }
                debouncedSetSummaryHeight();
            },
            onXHRError: (response) => { // Network errors, etc.
                console.error(`${LOG_PREFIX} XHR Error (Summary):`, response);
                if (streamEndedSuccessfully) return; // Stream already handled it
                removeLoadingIndicator();
                clearElementChildren(summaryContentDiv);
                const errorMsg = `Failed to fetch summary. Network error or server unavailable.`;
                renderMarkdownToElement(summaryContentDiv, `**Error:** ${errorMsg}`);
                appendRetryButton(summaryContentDiv, pageUrl, responseAreaElement, fetchSummaryAndUpdateUI);
                debouncedSetSummaryHeight();
            },
            onXHRTimeout: () => {
                if (streamEndedSuccessfully) return;
                removeLoadingIndicator();
                clearElementChildren(summaryContentDiv);
                renderMarkdownToElement(summaryContentDiv, "**Error:** Request timed out fetching summary.");
                appendRetryButton(summaryContentDiv, pageUrl, responseAreaElement, fetchSummaryAndUpdateUI);
                debouncedSetSummaryHeight();
            },
            onXHRLoadEnd: (event) => { // Request finished (could be success or HTTP error)
                currentSummaryXhr = null;
                if (streamEndedSuccessfully) return; // Already handled by onStreamEnd
                removeLoadingIndicator(); // Ensure it's removed
                // If not 200, and stream_end wasn't hit (e.g. immediate server error)
                if (event.status !== 200 && !summaryGenerated && accumulatedSummary.trim() === "") {
                    // Check if error already displayed by onErrorEvent
                    if (!summaryContentDiv.textContent.toLowerCase().includes("error") &&
                        !summaryContentDiv.textContent.toLowerCase().includes("stream error")) {
                        clearElementChildren(summaryContentDiv);
                        const errorDetail = event.responseText ? tryParseError(event.responseText) : `Server error ${event.status}`;
                        renderMarkdownToElement(summaryContentDiv, `**Error:** ${errorDetail}`);
                        appendRetryButton(summaryContentDiv, pageUrl, responseAreaElement, fetchSummaryAndUpdateUI);
                    }
                } else if (event.status === 200 && !accumulatedSummary.trim() && !summaryGenerated) {
                    // Got 200, but no content and no stream_end. This is unusual.
                    if (!summaryContentDiv.textContent.toLowerCase().includes("empty")) {
                        renderMarkdownToElement(summaryContentDiv, "Received empty response from server.");
                    }
                }
                debouncedSetSummaryHeight();
            }
        });
    }

    async function sendChatMessage() {
        const chatInput = document.getElementById(CHAT_INPUT_ID);
        const responseArea = document.getElementById(API_RESPONSE_AREA_ID);
        const currentVideoURL = window.location.href;

        if (!chatInput || !responseArea || !currentVideoURL || !originalSummaryContent) return;
        const userQuestion = chatInput.value.trim();
        if (!userQuestion) return;

        if (currentChatXhr && typeof currentChatXhr.abort === 'function') {
            currentChatXhr.abort();
            console.log(`${LOG_PREFIX} Aborted previous chat request.`);
        }
        currentChatXhr = null;

        messageHistory.push({ role: 'user', content: userQuestion });
        appendChatMessageToUI(responseArea, userQuestion, 'user', null);

        chatInput.value = '';
        chatInput.disabled = true;
        const sendButton = document.getElementById(SEND_BUTTON_ID);
        if (sendButton) sendButton.disabled = true;

        const assistantMessageStreamId = `assistant-message-${Date.now()}`;
        const assistantMessageDiv = appendChatMessageToUI(responseArea, "", 'assistant', assistantMessageStreamId);
        appendLoadingIndicator(assistantMessageDiv);

        let accumulatedAnswer = '';
        let streamEndedSuccessfully = false;

        console.log(`${LOG_PREFIX} Starting chat stream for question: "${userQuestion}"`);
        currentChatXhr = streamRequestGmXhr({
            url: 'http://yt-summarizer.lan/ask',
            method: 'POST',
            data: { url: currentVideoURL, original_summary: originalSummaryContent, history: messageHistory },
            onDataChunk: (data) => {
                removeLoadingIndicator();
                accumulatedAnswer += data.chunk;
                renderMarkdownToElement(assistantMessageDiv, accumulatedAnswer);
                responseArea.scrollTop = responseArea.scrollHeight;
            },
            onErrorEvent: (errorData) => {
                removeLoadingIndicator();
                const errorText = `**Stream Error:** ${errorData.error || 'Unknown stream error'}`;
                renderMarkdownToElement(assistantMessageDiv, errorText);
                messageHistory.push({ role: 'assistant', content: errorText });
            },
            onStreamEnd: () => {
                streamEndedSuccessfully = true;
                removeLoadingIndicator();
                if (accumulatedAnswer.trim() === "") {
                    const noAnswerText = "Assistant did not provide an answer.";
                    renderMarkdownToElement(assistantMessageDiv, noAnswerText);
                    messageHistory.push({ role: 'assistant', content: noAnswerText });
                } else {
                    messageHistory.push({ role: 'assistant', content: accumulatedAnswer });
                }
                chatInput.disabled = false;
                if (sendButton) sendButton.disabled = false;
                debouncedSetSummaryHeight();
            },
            onXHRError: (response) => {
                if (streamEndedSuccessfully) return;
                removeLoadingIndicator();
                const errorText = `**Error:** Failed to get chat response. Network error or server unavailable.`;
                renderMarkdownToElement(assistantMessageDiv, errorText);
                messageHistory.push({ role: 'assistant', content: errorText });
                chatInput.disabled = false; if (sendButton) sendButton.disabled = false;
                debouncedSetSummaryHeight();
            },
            onXHRTimeout: () => {
                if (streamEndedSuccessfully) return;
                removeLoadingIndicator();
                const errorText = "**Error:** Request timed out for chat response.";
                renderMarkdownToElement(assistantMessageDiv, errorText);
                messageHistory.push({ role: 'assistant', content: errorText });
                chatInput.disabled = false; if (sendButton) sendButton.disabled = false;
                debouncedSetSummaryHeight();
            },
            onXHRLoadEnd: (event) => {
                currentChatXhr = null;
                if (streamEndedSuccessfully) return;
                removeLoadingIndicator();
                if (event.status !== 200 && accumulatedAnswer.trim() === "") {
                    if (!assistantMessageDiv.textContent.toLowerCase().includes("error") &&
                        !assistantMessageDiv.textContent.toLowerCase().includes("stream error")) {
                        const errorDetail = event.responseText ? tryParseError(event.responseText) : `Server error ${event.status}`;
                        const errorText = `**Error:** ${errorDetail}`;
                        renderMarkdownToElement(assistantMessageDiv, errorText);
                        messageHistory.push({ role: 'assistant', content: errorText });
                    }
                } else if (event.status === 200 && !accumulatedAnswer.trim()) {
                    if (!assistantMessageDiv.textContent.toLowerCase().includes("empty")) {
                        const noAnswerText = "Received empty response from server for chat.";
                        renderMarkdownToElement(assistantMessageDiv, noAnswerText);
                        messageHistory.push({ role: 'assistant', content: noAnswerText });
                    }
                }
                if (chatInput.disabled) chatInput.disabled = false;
                if (sendButton && sendButton.disabled) sendButton.disabled = false;
                debouncedSetSummaryHeight();
            }
        });
    }

    function appendChatMessageToUI(responseArea, markdownContent, role, streamId = null) {
        const summaryDiv = document.getElementById(SUMMARY_CONTENT_ID);
        let needsSeparator = false;
        if (responseArea.lastChild) { // Check if there's any child at all
            if (responseArea.lastChild.id === SUMMARY_CONTENT_ID ||
                responseArea.lastChild.classList.contains('tldr-chat-message')) {
                needsSeparator = true;
            }
        }

        if (needsSeparator) {
            const hr = document.createElement('hr');
            hr.className = 'tldr-chat-separator';
            responseArea.appendChild(hr);
        }

        const messageDiv = document.createElement('div');
        if (streamId) messageDiv.id = streamId;
        messageDiv.className = `tldr-chat-message tldr-chat-message-${role}`;
        renderMarkdownToElement(messageDiv, markdownContent);
        responseArea.appendChild(messageDiv);
        responseArea.scrollTop = responseArea.scrollHeight;
        return messageDiv;
    }

    let loadingIndicator = null;
    function appendLoadingIndicator(parentElement) { // Changed to accept parentElement
        if (!parentElement) return;
        if (!loadingIndicator || loadingIndicator.parentElement !== parentElement) { // Create or move if needed
            if (loadingIndicator && loadingIndicator.parentNode) {
                loadingIndicator.parentNode.removeChild(loadingIndicator);
            }
            loadingIndicator = document.createElement('div');
            loadingIndicator.id = LOADING_INDICATOR_ID;
            loadingIndicator.textContent = ''; // Spinner is via CSS ::after
            loadingIndicator.classList.add('tldr-loading-spinner');
        }
        if (!loadingIndicator.parentNode) { // Only append if not already there
            parentElement.appendChild(loadingIndicator);
        }
        parentElement.scrollTop = parentElement.scrollHeight;
    }

    function removeLoadingIndicator() {
        if (loadingIndicator && loadingIndicator.parentNode) {
            loadingIndicator.parentNode.removeChild(loadingIndicator);
            // Don't nullify loadingIndicator here, it might be reused by appendLoadingIndicator
        }
    }


    function debounce(func, delay) { /* ... (keep existing) ... */
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func.apply(this, args), delay);
        };
    }
    function setSummaryHeight() { /* ... (keep existing, should work fine) ... */
        const playerElement = document.querySelector(PLAYER_SELECTOR);
        const responseArea = document.getElementById(API_RESPONSE_AREA_ID);
        const customElement = document.getElementById(CUSTOM_ELEMENT_ID);
        const headingContainer = document.getElementById(HEADING_CONTAINER_ID);
        const contentWrapper = document.getElementById(CONTENT_WRAPPER_ID);

        if (!playerElement || !responseArea || !customElement || !headingContainer || !contentWrapper || contentWrapper.style.display === 'none') {
            return;
        }
        const playerHeight = playerElement.offsetHeight;
        let spaceUsedByHeader = headingContainer.offsetHeight + parseFloat(getComputedStyle(headingContainer).marginBottom);
        const customElementStyle = getComputedStyle(customElement);
        const customElementPaddingTop = parseFloat(customElementStyle.paddingTop);
        const customElementPaddingBottom = parseFloat(customElementStyle.paddingBottom);
        const customElementBorderTop = parseFloat(customElementStyle.borderTopWidth);
        const customElementBorderBottom = parseFloat(customElementStyle.borderBottomWidth);
        const responseAreaStyle = getComputedStyle(responseArea);
        const responseAreaMarginTop = parseFloat(responseAreaStyle.marginTop);
        const chatContainer = document.getElementById(CHAT_CONTAINER_ID);
        let chatContainerTotalHeight = 0;
        if (chatContainer && chatContainer.style.display !== 'none') {
            const chatContainerStyle = getComputedStyle(chatContainer);
            chatContainerTotalHeight = chatContainer.offsetHeight + parseFloat(chatContainerStyle.marginTop) + parseFloat(chatContainerStyle.marginBottom) + parseFloat(chatContainerStyle.paddingTop) + parseFloat(chatContainerStyle.paddingBottom) + parseFloat(chatContainerStyle.borderTopWidth) + parseFloat(chatContainerStyle.borderBottomWidth);
        }
        const nonScrollingContentHeight = spaceUsedByHeader + customElementPaddingTop + customElementPaddingBottom + customElementBorderTop + customElementBorderBottom + responseAreaMarginTop + chatContainerTotalHeight;
        const buffer = 10;
        const calculatedMaxHeight = playerHeight - nonScrollingContentHeight - buffer;
        responseArea.style.maxHeight = `${Math.max(50, calculatedMaxHeight)}px`;
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
                                shouldUpdateHeight = true; break;
                            }
                            if (mutation.type === 'childList' && (mutation.target.id === 'primary' || mutation.target.id === 'secondary' || mutation.target.id === 'player-container')) {
                                shouldUpdateHeight = true; break;
                            }
                        }
                        if (shouldUpdateHeight) debouncedSetSummaryHeight();
                    });
                    playerHeightMutationObserver.observe(flexyElement, { attributes: true, attributeFilter: ['theater', 'is-fullscreen'], childList: true, subtree: true });
                });
            }
            window.addEventListener('resize', debouncedSetSummaryHeight);
            resizeListenerActive = true;
        }, 40, 250);
    }
    function cleanupObservers() {
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        if (playerHeightMutationObserver) { playerHeightMutationObserver.disconnect(); playerHeightMutationObserver = null; }
        if (resizeListenerActive) { window.removeEventListener('resize', debouncedSetSummaryHeight); resizeListenerActive = false; }
    }

    function injectCustomElement() {
        if (document.getElementById(CUSTOM_ELEMENT_ID)) {
            console.log(`${LOG_PREFIX} Custom element already exists.`);
            return;
        }
        const referenceNodeSelector = 'ytd-watch-next-secondary-results-renderer';
        waitForElement(referenceNodeSelector, (referenceNode) => {
            if (document.getElementById(CUSTOM_ELEMENT_ID)) return;
            const parentElement = referenceNode.parentNode;
            if (!parentElement) { console.error(`${LOG_PREFIX} Could not find parent of ${referenceNodeSelector}.`); return; }
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
            contentWrapper.style.display = 'none';
            const responseArea = document.createElement('div');
            responseArea.id = API_RESPONSE_AREA_ID;
            contentWrapper.appendChild(responseArea);
            const chatContainer = document.createElement('div');
            chatContainer.id = CHAT_CONTAINER_ID;
            chatContainer.style.display = 'none';
            const chatInput = document.createElement('input'); // Changed from textarea for simplicity in this example
            chatInput.id = CHAT_INPUT_ID;
            chatInput.type = 'text';
            chatInput.placeholder = 'Summary not available...';
            chatInput.disabled = true;
            const sendButton = document.createElement('button');
            sendButton.id = SEND_BUTTON_ID;
            sendButton.textContent = 'Send';
            sendButton.className = 'tldr-chat-button';
            sendButton.disabled = true;
            chatContainer.appendChild(chatInput);
            chatContainer.appendChild(sendButton);
            contentWrapper.appendChild(chatContainer);
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
                            if (responseAreaElem) fetchSummaryAndUpdateUI(currentVideoURL, responseAreaElem);
                        } else {
                            const responseAreaElem = document.getElementById(API_RESPONSE_AREA_ID);
                            if (responseAreaElem) {
                                clearElementChildren(responseAreaElem);
                                const orangeSpan = document.createElement('span');
                                orangeSpan.style.color = 'orange';
                                orangeSpan.textContent = 'Not a valid video watch page.';
                                responseAreaElem.appendChild(orangeSpan);
                            }
                            if (chatInput) { chatInput.disabled = true; chatInput.placeholder = 'Not a video page.'; chatInput.value = ''; }
                            if (sendButton) sendButton.disabled = true;
                            if (chatContainer) chatContainer.style.display = 'none';
                        }
                    }
                }
                debouncedSetSummaryHeight();
            });
            sendButton.addEventListener('click', sendChatMessage);
            chatInput.addEventListener('keypress', (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendChatMessage();
                }
            });
            parentElement.insertBefore(customElement, referenceNode);
            console.log(`${LOG_PREFIX} Custom element injected.`);
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
        #${API_RESPONSE_AREA_ID} strong, #${SUMMARY_CONTENT_ID} strong {
            color: #f0f0f0;
            font-weight: bold;
        }
        /* Markdown specific styles */
        #${API_RESPONSE_AREA_ID} p, #${SUMMARY_CONTENT_ID} p {
            margin-top: 0.5em;
            margin-bottom: 0.5em;
        }
        #${API_RESPONSE_AREA_ID} h1, #${API_RESPONSE_AREA_ID} h2, #${API_RESPONSE_AREA_ID} h3,
        #${API_RESPONSE_AREA_ID} h4, #${API_RESPONSE_AREA_ID} h5, #${API_RESPONSE_AREA_ID} h6,
        #${SUMMARY_CONTENT_ID} h1, #${SUMMARY_CONTENT_ID} h2, #${SUMMARY_CONTENT_ID} h3,
        #${SUMMARY_CONTENT_ID} h4, #${SUMMARY_CONTENT_ID} h5, #${SUMMARY_CONTENT_ID} h6 {
            color: #e8e8e8;
            margin-top: 1em;
            margin-bottom: 0.5em;
            border-bottom: 1px solid #4a4a4a;
            padding-bottom: 0.2em;
        }
        #${API_RESPONSE_AREA_ID} h1, #${SUMMARY_CONTENT_ID} h1 { font-size: 1.5em; }
        #${API_RESPONSE_AREA_ID} h2, #${SUMMARY_CONTENT_ID} h2 { font-size: 1.3em; }
        #${API_RESPONSE_AREA_ID} h3, #${SUMMARY_CONTENT_ID} h3 { font-size: 1.15em; }

        #${API_RESPONSE_AREA_ID} ul, #${API_RESPONSE_AREA_ID} ol,
        #${SUMMARY_CONTENT_ID} ul, #${SUMMARY_CONTENT_ID} ol {
            margin-left: 20px;
            padding-left: 10px;
        }
        #${API_RESPONSE_AREA_ID} li, #${SUMMARY_CONTENT_ID} li {
            margin-bottom: 0.3em;
        }
        #${API_RESPONSE_AREA_ID} code, #${SUMMARY_CONTENT_ID} code {
            background-color: #383838;
            padding: 2px 5px;
            border-radius: 4px;
            font-family: Consolas, Monaco, 'Andale Mono', 'Ubuntu Mono', monospace;
            font-size: 0.9em;
            color: #d0d0d0;
        }
        #${API_RESPONSE_AREA_ID} pre, #${SUMMARY_CONTENT_ID} pre {
            background-color: #111111;
            border: 1px solid #3a3a3a;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 10px 0;
        }
        #${API_RESPONSE_AREA_ID} pre code, #${SUMMARY_CONTENT_ID} pre code {
            background-color: transparent;
            padding: 0;
            border: none;
            font-size: 1em;
        }
        #${API_RESPONSE_AREA_ID} blockquote, #${SUMMARY_CONTENT_ID} blockquote {
            border-left: 4px solid #555555;
            padding-left: 15px;
            margin-left: 0;
            color: #b0b0b0;
            font-style: italic;
        }
        #${API_RESPONSE_AREA_ID} table, #${SUMMARY_CONTENT_ID} table {
            border-collapse: collapse;
            width: 100%;
            margin: 1em 0;
        }
        #${API_RESPONSE_AREA_ID} th, #${API_RESPONSE_AREA_ID} td,
        #${SUMMARY_CONTENT_ID} th, #${SUMMARY_CONTENT_ID} td {
            border: 1px solid #4a4a4a;
            padding: 8px;
            text-align: left;
        }
        #${API_RESPONSE_AREA_ID} th, #${SUMMARY_CONTENT_ID} th {
            background-color: #3a3a3a;
        }
        #${API_RESPONSE_AREA_ID} a, #${SUMMARY_CONTENT_ID} a {
            color: #58a6ff;
            text-decoration: none;
        }
        #${API_RESPONSE_AREA_ID} a:hover, #${SUMMARY_CONTENT_ID} a:hover {
            text-decoration: underline;
        }
        #${API_RESPONSE_AREA_ID} hr, #${SUMMARY_CONTENT_ID} hr { /* This applies to markdown <hr>, not chat separator */
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
            flex-direction: row;
            gap: 10px;
            align-items: flex-end;
        }
        #${CHAT_INPUT_ID} {
            background-color: #333333;
            border: 1px solid #555555;
            color: #e0e0e0;
            padding: 8px 10px;
            border-radius: 4px;
            font-size: 0.9em;
            flex-grow: 1;
            box-sizing: border-box;
            font-family: inherit;
            resize: vertical;
            min-height: 38px;
        }
        #${CHAT_INPUT_ID}:focus {
            outline: none;
            border-color: #77b0ff;
            box-shadow: 0 0 0 2px rgba(119, 176, 255, 0.3);
        }
        .tldr-chat-button {
            background-color: #007bff;
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
            height: fit-content;
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
        /* .tldr-chat-message defined earlier */
        .tldr-chat-separator {
            border: 0;
            border-top: 1px dashed #666666;
            margin: 0.5em 0; /* Reduced margin for chat separators */
        }
        #${LOADING_INDICATOR_ID} {
            font-weight: bold;
            font-size: 3em; /* Or smaller if inside a message bubble */
            color: #cccccc;
            text-align: center;
            width: 100%; /* Take full width if it's a general indicator */
         }
         @keyframes tldr-dot-spinner {
             0%, 100% { content: '·..'; } 15% { content: '··.'; } 30% { content: '···'; }
             45% { content: '.··'; } 60% { content: '..·'; } 75% { content: '...'; }
         }
         .tldr-loading-spinner::after {
             content: '...'; display: inline-block; vertical-align: bottom;
             animation: tldr-dot-spinner 1.5s infinite steps(6, end);
         }
    `);

    let lastUrl = '';
    function initialize() {
        console.log(`${LOG_PREFIX} Script initialized (Streaming). Current URL: ${window.location.href}`);
        lastUrl = location.href;
        if (lastUrl.includes("/watch")) {
            injectCustomElement();
        } else {
            const oldElement = document.getElementById(CUSTOM_ELEMENT_ID);
            if (oldElement) { oldElement.remove(); cleanupObservers(); /* Reset states if any */ }
        }
        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                console.log(`${LOG_PREFIX} URL changed to ${url}.`);
                lastUrl = url;

                // Abort any ongoing requests
                if (currentSummaryXhr && typeof currentSummaryXhr.abort === 'function') {
                    currentSummaryXhr.abort(); currentSummaryXhr = null;
                    console.log(`${LOG_PREFIX} Aborted summary request due to URL change.`);
                }
                if (currentChatXhr && typeof currentChatXhr.abort === 'function') {
                    currentChatXhr.abort(); currentChatXhr = null;
                    console.log(`${LOG_PREFIX} Aborted chat request due to URL change.`);
                }
                removeLoadingIndicator(); // Ensure no stale indicators

                const existingElement = document.getElementById(CUSTOM_ELEMENT_ID);
                if (url.includes("/watch")) {
                    if (existingElement) {
                        const responseArea = document.getElementById(API_RESPONSE_AREA_ID);
                        const contentWrapper = document.getElementById(CONTENT_WRAPPER_ID);
                        const toggleIndicator = document.getElementById(TOGGLE_INDICATOR_ID);
                        const chatInput = document.getElementById(CHAT_INPUT_ID);
                        const sendButton = document.getElementById(SEND_BUTTON_ID);
                        const chatContainer = document.getElementById(CHAT_CONTAINER_ID);

                        if (responseArea) clearElementChildren(responseArea);
                        summaryGenerated = false; originalSummaryContent = ''; messageHistory = [];
                        if (contentWrapper) contentWrapper.style.display = 'none';
                        if (toggleIndicator) toggleIndicator.textContent = '+';
                        existingElement.setAttribute('data-is-expanded', 'false');

                        if (chatInput) { chatInput.value = ''; chatInput.disabled = true; chatInput.placeholder = 'Summary not available...'; }
                        if (sendButton) sendButton.disabled = true;
                        if (chatContainer) chatContainer.style.display = 'none';

                        console.log(`${LOG_PREFIX} Reset content for new video page.`);
                        observePlayerForHeightChanges(); // Re-observe for new page layout
                    } else {
                        setTimeout(injectCustomElement, 500);
                    }
                } else {
                    if (existingElement) {
                        existingElement.remove();
                        cleanupObservers();
                        summaryGenerated = false; originalSummaryContent = ''; messageHistory = [];
                        console.log(`${LOG_PREFIX} Removed custom element (navigated from watch page).`);
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