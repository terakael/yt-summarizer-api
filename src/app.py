import json
import logging
import sys

import os
import asyncio
from quart import Quart, request, jsonify, Response
from llm_providers import get_llm_provider
from transcripts import fetch_transcript, TranscriptNotFoundError
from cachetools import TTLCache, cached

# Configure logging
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stdout)
formatter = logging.Formatter(
    "%(asctime)s - %(name)s - %(levelname)s - %(module)s:%(funcName)s:%(lineno)d - %(message)s"
)
handler.setFormatter(formatter)
logger.addHandler(handler)

llm_provider = get_llm_provider()

API_CACHE_MAX_SIZE = 128
API_CACHE_TTL_SECONDS = 60 * 60  # an hour

# Create a TTLCache instance
# This is the cache object that the @cached decorator will use.
api_response_cache = TTLCache(maxsize=API_CACHE_MAX_SIZE, ttl=API_CACHE_TTL_SECONDS)


def read_prompt(filename):
    """Helper function to read a prompt file."""
    filepath = os.path.join("prompts", f"{filename}.md")
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Prompt file not found: {filepath}")
    with open(filepath, "r") as f:
        return f.read()


# Ensure prompts directory exists and files are present before loading
prompts_dir = "prompts"
if not os.path.isdir(prompts_dir):
    os.makedirs(prompts_dir)
    # Create dummy files if they don't exist, for easier first run
    if not os.path.exists(os.path.join(prompts_dir, "summarize.md")):
        with open(os.path.join(prompts_dir, "summarize.md"), "w") as f:
            f.write("Summarize this: {{transcript}}")
    if not os.path.exists(os.path.join(prompts_dir, "ask.md")):
        with open(os.path.join(prompts_dir, "ask.md"), "w") as f:
            f.write("Answer based on this: {{context}} Question: {{question}}")


prompts = {name: read_prompt(name) for name in ["ask", "summarize"]}
app = Quart(__name__)


@cached(cache=api_response_cache)
def fetch_cached_transcript(video_id: str):
    return fetch_transcript(video_id)


async def fetch_transcript_with_retries(
    video_id, logger, total_attempts=3, initial_delay_seconds=2
):
    """
    Fetches YouTube transcript with retries and exponential backoff.

    Args:
        video_id (str): The YouTube video ID.
        logger: The application logger instance.
        total_attempts (int): Total number of attempts (e.g., 3 means 1 initial + 2 retries).
        initial_delay_seconds (int): Initial delay in seconds for backoff before the first retry.

    Returns:
        tuple: (transcript_list, None) on success.
               (None, error_event_string) on failure, where error_event_string is SSE formatted.
    """
    num_attempts_to_make = max(1, total_attempts)  # Ensure at least one attempt

    for attempt_num_zero_based in range(num_attempts_to_make):
        current_attempt_one_based = attempt_num_zero_based + 1
        try:
            if num_attempts_to_make > 1:
                logger.info(
                    f"Attempt {current_attempt_one_based}/{num_attempts_to_make} to fetch transcript for {video_id}"
                )
            else:
                logger.info(f"Fetching transcript for {video_id}")

            transcript_list = fetch_cached_transcript(video_id)
            logger.info(
                f"Successfully fetched transcript for {video_id} on attempt {current_attempt_one_based}"
            )
            return transcript_list, None  # Success

        except TranscriptNotFoundError as e:
            logger.error(
                f"Transcript does not exist for {video_id}, failing immediately"
            )
            error_event = f"event: error\ndata: {json.dumps({'error': str(e), 'status_code': 404})}\n\n"
            return None, error_event

        except Exception as e:
            logger.warning(
                f"Attempt {current_attempt_one_based}/{num_attempts_to_make} failed for {video_id}: {str(e)}"
            )

            if attempt_num_zero_based == num_attempts_to_make - 1:
                # This was the last attempt
                logger.error(
                    f"Error fetching transcript for {video_id} after {num_attempts_to_make} attempts: {str(e)}"
                )
                error_event = f"event: error\ndata: {json.dumps({'error': f'Error fetching transcript after {num_attempts_to_make} attempts: {str(e)}', 'status_code': 500})}\n\n"
                return None, error_event  # Retries exhausted

            # Calculate delay for the next retry (exponential backoff)
            # Delay = initial_delay * (2 ^ number_of_previous_failures)
            # Here, attempt_num_zero_based is 0 for the first try, 1 for the second, etc.
            # So, 2 ** attempt_num_zero_based is correct for the delay *before* the next attempt.
            delay = initial_delay_seconds
            logger.info(f"Retrying in {delay} seconds...")
            await asyncio.sleep(delay)

    # Fallback: This should ideally not be reached if num_attempts_to_make >= 1,
    # as all outcomes (success, definitive error, retries exhausted) should return from the loop.
    logger.error(f"Transcript fetching for {video_id} unexpectedly exited retry loop.")
    final_error_event = f"event: error\ndata: {json.dumps({'error': 'Unknown error fetching transcript after all retries', 'status_code': 500})}\n\n"
    return None, final_error_event


@app.route("/")
async def hello():
    return "Hello World - Streaming LLM API"


@app.route("/summarize", methods=["POST"])
async def summarize():
    try:
        data = await request.get_json()
        if not data or not isinstance(data, dict):
            return jsonify({"error": "Invalid JSON payload"}), 400
        video_url = data.get("url")

        if not video_url:
            return jsonify({"error": "URL parameter is required"}), 400

        try:
            video_id = video_url.split("v=")[1].split("&")[0]
        except IndexError:
            return jsonify({"error": "Invalid YouTube URL format"}), 400

        async def stream_generator():
            headers = {  # Standard SSE headers
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
            try:
                # Send video_id as an initial metadata event
                yield f"event: metadata\ndata: {json.dumps({'video_id': video_id})}\n\n"

                # Fetch transcript using the new helper function
                transcript_list, error_event = await fetch_transcript_with_retries(
                    video_id,
                    logger,  # Pass the new logger instance
                    total_attempts=100,
                    initial_delay_seconds=1,
                )

                if (
                    error_event
                ):  # If fetch_transcript_with_retries returned an error event string
                    yield error_event
                    return  # Stop generation

                transcript_text = " ".join([entry["text"] for entry in transcript_list])

                # Stream the summary from LLM
                async for chunk in llm_provider.generate_content_stream(
                    prompts["summarize"],
                    f"The transcript:\n\n```{transcript_text}\n```",
                ):
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"

                yield f"event: stream_end\ndata: {json.dumps({'message': 'Summary stream finished'})}\n\n"

            except Exception as e:
                logger.error(f"Error during /summarize stream generation: {str(e)}")
                # Ensure a final error event is sent if an unexpected error occurs mid-stream
                error_payload = json.dumps(
                    {
                        "error": "An unexpected error occurred during streaming.",
                        "status_code": 500,
                    }
                )
                yield f"event: error\ndata: {error_payload}\n\n"

        # Return a streaming response
        return Response(stream_generator(), mimetype="text/event-stream")

    except Exception as e:
        # Catches errors *before* streaming starts (e.g., bad JSON in request, initial validation)
        logger.error(f"Pre-stream error in /summarize: {str(e)}")
        return jsonify({"error": f"An error occurred: {str(e)}"}), 500


@app.route("/ask", methods=["POST"])
async def ask_question():
    try:
        data = await request.get_json()
        if not data or not isinstance(data, dict):
            return jsonify({"error": "Invalid JSON payload"}), 400

        video_url = data.get("url")
        summary = data.get(
            "original_summary", ""
        )  # Default to empty string if not provided
        message_history = data.get("history", [])

        if (
            not message_history
            or not isinstance(message_history, list)
            or not message_history[-1].get("content")
        ):
            return (
                jsonify(
                    {
                        "error": "Valid message history (list of dicts with 'content') ending with current question is required"
                    }
                ),
                400,
            )

        question = message_history[-1]["content"]

        if not video_url:
            return jsonify({"error": "URL parameter is required"}), 400
        if (
            not question or len(question.strip()) < 1
        ):  # Reduced minimum length for easier testing
            return (
                jsonify({"error": "Question must be at least 1 character"}),
                422,
            )

        try:
            video_id = video_url.split("v=")[1].split("&")[0]
        except IndexError:
            return jsonify({"error": "Invalid YouTube URL format"}), 400

        async def stream_generator():
            headers = {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
            try:
                # Fetch transcript using the new helper function
                transcript_list, error_event = await fetch_transcript_with_retries(
                    video_id,
                    logger,  # Pass the new logger instance
                    total_attempts=100,
                    initial_delay_seconds=1,
                )

                if (
                    error_event
                ):  # If fetch_transcript_with_retries returned an error event string
                    yield error_event
                    return  # Stop generation

                transcript_text = " ".join([entry["text"] for entry in transcript_list])

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

                # Stream the answer from LLM
                async for chunk in llm_provider.generate_content_stream(
                    prompts["ask"], user_prompt
                ):
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"

                yield f"event: stream_end\ndata: {json.dumps({'message': 'Answer stream finished'})}\n\n"

            except Exception as e:
                logger.error(f"Error during /ask stream generation: {str(e)}")
                error_payload = json.dumps(
                    {
                        "error": "An unexpected error occurred during streaming.",
                        "status_code": 500,
                    }
                )
                yield f"event: error\ndata: {error_payload}\n\n"

        return Response(stream_generator(), mimetype="text/event-stream")

    except Exception as e:
        # Catches errors *before* streaming starts
        logger.error(f"Pre-stream error in /ask: {str(e)}")
        return jsonify({"error": f"An error occurred: {str(e)}"}), 500


if __name__ == "main":
    # Ensure llm_provider is initialized before app.run
    # This is already done at the global scope.
    logger.info("Starting Quart app...")
    app.run(host="0.0.0.0", port=5000)
