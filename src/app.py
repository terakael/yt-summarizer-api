import json
import re
from quart import Quart, request, jsonify
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound
from llm_providers import get_llm_provider

# Initialize LLM provider
llm_provider = get_llm_provider()

SYSTEM_PROMPT = """You are an expert content summarizer. Your task is to analyze the provided YouTube video transcript and generate a comprehensive "Too Long; Didn't Read" (TL;DR) summary.

The ultimate goal of this TL;DR is to give a reader a complete understanding of all the relevant information and key takeaways from the video, as if they had watched it themselves, but in a **highly condensed, exceptionally concise format**. The priority is maximum information density in minimal words.

**Instructions for the TL;DR:**

1.  **Content Focus & Brevity:**
    *   Identify and convey the video's main topic, purpose, or central thesis **as concisely as possible**.
    *   Extract and present *only* the most critical arguments, points, information, or steps discussed. **Eliminate any non-essential details.**
    *   Include crucial examples, evidence, data, or demonstrations *only if they are absolutely central* to the video's core message and cannot be omitted without losing meaning.
    *   State the main conclusions, outcomes, or calls to action presented in the video with extreme brevity.
    *   **The summary MUST be significantly shorter than the source transcript, focusing on core facts and actionable insights.**

2.  **Style and Tone:**
    *   **Directly state the information.** Present the content as facts, claims, or processes described *within* the video.
    *   **Ruthlessly concise and to the point.** Eliminate all fluff, repetition, and unnecessary words. Aim for telegraphic style where appropriate.
    *   The tone should be objective and informative.

3.  **Effective Formatting with Markdown:**
    *   **ALWAYS utilize Markdown *judiciously* to enhance the readability and scannability of the already-concise summary.** Markdown should *aid* brevity, not cause verbosity.
    *   Employ elements like:
        *   **Headings (`#`, `##`, `###`)** sparingly, *only if* they significantly improve segmentation for a very distinct topic shift and help condense information. Avoid creating headings that simply introduce one or two bullet points.
        *   **Bullet points (`-` or `*`)** for lists of key points, arguments, features, benefits, or sequential steps. Use them to break up dense text, not to add extra words.
        *   **Numbered lists (`1.`, `2.`)** for ordered sequences, rankings, or multi-step processes when the order is critical.
        *   **Bold (`**text**`)** for emphasis on *critical terms*, definitions, or *paramount takeaways*. Use sparingly to highlight what's truly essential.
        *   *Italics (`*text*`)* for subtle emphasis or specific terminology, also sparingly.
    *   **The goal is to make the summary highly readable and scannable *while remaining extremely concise*. A plain block of text is still undesirable, but verbose, over-formatted text is also unacceptable.**

4.  **Crucial Output Constraint:**
    *   **DO NOT** use phrases like: "The speaker says...", "This video discusses...", "The transcript explains...", "According to the video...", "The main point of the video is...", "In this video, we learn..." or any similar meta-commentary referring to the speaker, the video itself, or the act of summarizing.
    *   Begin directly with the summarized content.

**Example of what NOT to do (regarding meta-commentary):**
"The speaker argues that effective time management involves prioritization and then lists several techniques."

**Example of what TO do (assuming the video's content supports this, demonstrating *concise* summary with *effective* Markdown):**

```markdown
# Remote Work Efficiency

Effective remote work demands **discipline** and strategic planning for optimal productivity.

## Core Principles:
*   **Routine:** Consistent daily structure, including dedicated work hours and breaks.
*   **Communication:** Leverage tools (e.g., Slack) for clear, real-time updates. *Regular check-ins are vital.*
*   **Workspace:** Designate a distraction-free area.

## Key Tools:
1.  **Project Management:** Trello, Asana for task tracking.
2.  **Conferencing:** Zoom, Google Meet for meetings. *Avoid excessive virtual calls.*

**Outcome:** Increased autonomy and productivity through conscious effort to prevent burnout.
```

You will be provided with the video transcript. Your response should be ONLY the TL;DR, formatted as Markdown (do NOT include the code fences)."""

app = Quart(__name__)


@app.route("/")
async def hello():
    return "Hello World"


@app.route("/summarize", methods=["POST"])
async def summarize():
    try:
        data = await request.get_json()
        video_url = data.get("url")

        if not video_url:
            return jsonify({"error": "URL parameter is required"}), 400

        video_id = video_url.split("v=")[1].split("&")[0]
        transcript = YouTubeTranscriptApi.get_transcript(video_id)

        # Combine transcript text
        transcript_text = " ".join([entry["text"] for entry in transcript])

        # Get summary from configured LLM provider
        summary = llm_provider.generate_content(
            SYSTEM_PROMPT, f"The transcript:\n\n```{transcript_text}\n```"
        )

        # Remove code fences if present
        if summary.startswith("```") and summary.endswith("```"):
            summary = re.sub(r"^```.*?\n|\n```$", "", summary, flags=re.DOTALL)

        return jsonify({"video_id": video_id, "summary": summary})

    except (TranscriptsDisabled, NoTranscriptFound):
        return jsonify({"error": "Transcript not available for this video"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/ask", methods=["POST"])
async def ask_question():
    try:
        data = await request.get_json()
        video_url = data.get("url")
        summary = data.get("original_summary")
        message_history = data.get("history", [])
        question = message_history[-1]["content"]

        if not video_url:
            return jsonify({"error": "URL parameter is required"}), 400
        if not question or len(question.strip()) < 5:
            return jsonify({"error": "Question must be at least 5 characters"}), 422

        video_id = video_url.split("v=")[1].split("&")[0]
        transcript = YouTubeTranscriptApi.get_transcript(video_id)
        transcript_text = " ".join([entry["text"] for entry in transcript])

        system_prompt = """You are an expert AI assistant dedicated to providing information and insights exclusively from a given YouTube video's content. Your primary goal is to help the user gain a deeper and more precise understanding of the video's content by answering their questions.

You will be provided with the following information:
1.  `<TRANSCRIPT>`: The full YouTube video transcript.
2.  `<SUMMARY>`: A markdown summary of the video transcript.
3.  `<CHAT_HISTORY>`: The ongoing conversation between the user and you.

**Here are your strict guidelines:**

1.  **Source Material Only:** Your answers MUST come exclusively from the provided `<TRANSCRIPT>` and `<SUMMARY>`. Do NOT use any external knowledge, personal opinions, or make assumptions.
2.  **Prioritization:**
    *   Use the `<SUMMARY>` for general understanding, quick overviews, and answering broader questions.
    *   Refer to the `<TRANSCRIPT>` for specific details, direct quotes, nuanced explanations, or when the user asks for information not sufficiently detailed in the summary.
3.  **Chat History:** Utilize the `<CHAT_HISTORY>` to understand the ongoing conversation context and avoid redundant information, building on previous turns.
4.  **Concise and To The Point:** All your responses must be as concise and direct as possible. Avoid conversational filler, excessive preamble, or unnecessary politeness. Get straight to the answer.
5.  **Markdown Format:** All your responses MUST be formatted using Markdown. Use headings, bullet points, bolding, or code blocks where appropriate to enhance readability and structure the information.
6.  **Out-of-Scope Questions:** If a user asks a question whose answer is NOT present in the provided `<TRANSCRIPT>` or `<SUMMARY>`, you must politely and concisely state that the information is not covered in the video. Do not attempt to guess or invent an answer.
7.  **Maintain Focus:** Keep your responses strictly focused on explaining, elaborating on, or summarizing the content of the YouTube video.

"""

        user_prompt = f"""
<TRANSCRIPT>
{transcript_text}
</TRANSCRIPT>

<SUMMARY>
{summary}
</SUMMARY>

<CHAT_HISTORY>
```json
{json.dumps(message_history)}
```
</CHAT_HISTORY>

<CURRENT_QUESTION>
{question}
</CURRENT_QUESTION>
"""

        response = llm_provider.generate_content(system_prompt, user_prompt)
        return jsonify({"answer": response})

    except (TranscriptsDisabled, NoTranscriptFound):
        return jsonify({"error": "Transcript not available for this video"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
