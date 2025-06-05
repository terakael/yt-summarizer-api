import json
import re
import os

from quart import Quart, request, jsonify
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound
from llm_providers import get_llm_provider

llm_provider = get_llm_provider()


def read_prompt(filename):
    """Helper function to read a prompt file."""
    filepath = os.path.join("prompts", f"{filename}.md")
    with open(filepath, "r") as f:
        return f.read()


prompts = {name: read_prompt(name) for name in ["ask", "summarize"]}

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
            prompts["summarize"], f"The transcript:\n\n```{transcript_text}\n```"
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

        response = llm_provider.generate_content(prompts["ask"], user_prompt)
        return jsonify({"answer": response})

    except (TranscriptsDisabled, NoTranscriptFound):
        return jsonify({"error": "Transcript not available for this video"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
