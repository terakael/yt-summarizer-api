from quart import Quart, request, jsonify
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound
import google.generativeai as genai
import os

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
            f"Summarize this YouTube video transcript in 3-5 bullet points:\n{transcript_text}"
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
