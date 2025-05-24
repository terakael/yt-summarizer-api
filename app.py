from quart import Quart, request, jsonify
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound
import google.generativeai as genai
import os

SYSTEM_PROMPT = """You are an expert content summarizer. Your task is to analyze the provided YouTube video transcript and generate a comprehensive "Too Long; Didn't Read" (TL;DR) summary.

The goal of this TL;DR is to give a reader a complete understanding of all the relevant information and key takeaways from the video, as if they had watched it themselves, but in a highly condensed format.

**Instructions for the TL;DR:**

1.  **Content Focus:**
    *   Identify and convey the video's main topic, purpose, or central thesis.
    *   Extract and present all key arguments, points, information, or steps discussed.
    *   Include any crucial examples, evidence, data, or demonstrations if they are central to the video's message.
    *   State the main conclusions, outcomes, or calls to action presented in the video.

2.  **Style and Tone:**
    *   **Directly state the information.** Present the content as facts, claims, or processes described *within* the video.
    *   **Concise and to the point.** Eliminate fluff or unnecessary details, but ensure all *relevant* information is retained.
    *   The tone should be objective and informative.

3.  **Crucial Formatting Constraint:**
    *   **DO NOT** use phrases like: "The speaker says...", "This video discusses...", "The transcript explains...", "According to the video...", "The main point of the video is...", "In this video, we learn..." or any similar meta-commentary referring to the speaker, the video itself, or the act of summarizing.
    *   Begin directly with the summarized content.

**Example of what NOT to do:**
"The speaker argues that effective time management involves prioritization and then lists several techniques."

**Example of what TO do (assuming the video's content supports this):**
"Effective time management hinges on robust prioritization. Key techniques include [Technique A described in video], [Technique B], and [Technique C]. Implementing these can lead to [Outcome mentioned in video]."

You will be provided with the video transcript. Your response should be ONLY the TL;DR."""

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

        # Configure Gemini
        genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
        model = genai.GenerativeModel("gemini-2.0-flash-exp")

        # Combine transcript text
        transcript_text = " ".join([entry["text"] for entry in transcript])

        # Get summary from Gemini
        response = model.generate_content(
            contents=f"{SYSTEM_PROMPT}\n\nThe transcript:\n\n```{transcript_text}\n```",
        )

        return jsonify({"video_id": video_id, "summary": response.text})

    except (TranscriptsDisabled, NoTranscriptFound):
        return jsonify({"error": "Transcript not available for this video"}), 404
    except Exception as e:
        if "GEMINI_API_KEY" not in os.environ:
            return jsonify({"error": "Gemini API key not configured"}), 500
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
