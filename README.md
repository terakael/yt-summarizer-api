# YouTube Video Summarizer & Q&A

This project offers a solution for summarizing YouTube videos and conducting interactive Q&A sessions. It uses Large Language Models (LLMs) to process video content and generate summaries and responses.

## Purpose & Motivation

The primary goal of this project is to enhance the YouTube viewing experience by allowing users to quickly grasp the core content of videos without needing to watch them in their entirety. It also facilitates deeper engagement by providing an interactive Q&A mechanism, enabling users to extract specific information from video content efficiently.

## Features

*   **Transcript Extraction:** Automatically fetches transcripts for YouTube videos.
*   **Video Summarization:** Generates concise, LLM-powered summaries.
*   **Interactive Q&A:** Enables users to ask questions about video content, with LLMs providing answers based on transcripts and chat history.
*   **Streaming Responses:** Summaries and Q&A responses are streamed in real-time for a dynamic user experience.
*   **Browser Integration:** A browser script injects a user interface directly into YouTube pages for easy access.

## Technologies Used

### Backend
*   **Web Framework:** Used for building the API.
*   **Transcript Fetching:** A library for reliable YouTube video transcript retrieval.
*   **LLM Integration:** Connects with leading LLM services for content generation.
*   **ASGI Server:** Runs the backend application efficiently.

### Frontend
*   **Browser Extension Platform:** Injects custom UI and functionality into web pages.
*   **Markdown Rendering:** Parses and displays markdown content within the browser.
*   **HTML Sanitization:** Ensures security and integrity of rendered content.

### Infrastructure
*   **Containerization:** Used for packaging the backend application, ensuring consistent environments and easy deployment.
*   **Orchestration:** Manages the deployment and scaling of the backend application, enabling high availability.
*   **Configuration Management:** Handles sensitive settings like LLM API keys and model configurations.

## Architecture & Workflow

The system operates through a client-server architecture with a focus on real-time interaction:

1.  **UI Injection:** A browser script loads and injects a custom user interface element when a user visits a YouTube video page.
2.  **Summary Request:** The user initiates a summary request via the injected UI. The browser script sends a request to the backend, including the YouTube video URL.
3.  **Transcript & LLM Processing:** The backend extracts the video ID, fetches the transcript, and sends it to the configured LLM with a summarization prompt.
4.  **Streamed Summary:** The LLM's summary is streamed back to the browser script using Server-Sent Events (SSE). The frontend receives and renders these chunks in real-time, updating the UI dynamically.
5.  **Q&A Interaction:** For questions, the user types into the chat interface. The browser script sends a request to the backend, providing the video URL, original summary, and chat history.
6.  **Contextual Q&A:** The backend processes this request, potentially re-fetching the transcript, and sends the relevant context (transcript, summary, chat history, question) to the LLM with a Q&A prompt.
7.  **Streamed Answer:** The LLM's answer is streamed back to the browser script and rendered in the chat UI, maintaining an interactive conversation flow.
8.  **Scalable Deployment:** The backend application is designed for containerized deployment, ensuring robust, scalable, and highly available operation.

## How to Use / Get Started

To use this service:

1.  **Backend Deployment:** Deploy the backend application (containerized) to a suitable environment or run it locally. Ensure necessary environment variables for LLM API keys and models are configured.
2.  **Browser Script:** Install the browser script in your browser using a compatible extension. This script will inject the necessary UI onto YouTube pages.

Once both components are set up, navigate to any YouTube video, and the summarization and Q&A features will be available directly on the page.