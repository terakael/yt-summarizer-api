import requests
import base64
import json
from googleapiclient.discovery import build
import os


class TranscriptNotFoundError(Exception):
    """Raised when a requested transcript cannot be found for a video."""

    def __init__(self, video_id: str):
        self.video_id = video_id
        super().__init__(f"Requested transcript does not exist for video: {video_id}")


# --- Configuration ---
# IMPORTANT: Replace '<YOUR-YOUTUBE-API-KEY>' with your actual YouTube Data API Key.
# It's highly recommended to set this as an environment variable:
# export YOUTUBE_API_KEY="YOUR_KEY_HERE"
# You can get one from Google Cloud Console: https://console.cloud.google.com/apis/credentials
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "<YOUR-YOUTUBE-API-KEY>")

# Initialize YouTube Data API client (global for reusability)
youtube_client = None
if YOUTUBE_API_KEY != "<YOUR-YOUTUBE-API-KEY>":
    try:
        youtube_client = build("youtube", "v3", developerKey=YOUTUBE_API_KEY)
    except Exception as e:
        print(
            f"Warning: Could not initialize YouTube Data API client. "
            f"Some functionality (like default language detection) might be affected. Error: {e}"
        )
else:
    print(
        "WARNING: YOUTUBE_API_KEY is not set. "
        "The script will attempt to proceed, but 'getDefaultSubtitleLanguage' "
        "will fail. Please set your YouTube Data API Key."
    )

# --- Protobuf Encoding Helpers (Manual implementation for the specific simple schema) ---
# This part manually constructs the binary Protobuf message for the `param1` and `param2` fields.
# The schema is implicitly:
# message SimpleMessage {
#   string param1 = 1; // Field number 1
#   string param2 = 2; // Field number 2
# }


def _encode_varint(value: int) -> bytes:
    """Encodes a single unsigned integer as a Protobuf varint."""
    parts = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            byte |= 0x80  # Set MSB if there are more bytes to follow
        parts.append(byte)
        if not value:
            break
    return bytes(parts)


def _encode_string_field(field_number: int, value: str) -> bytes:
    """
    Encodes a single string field according to Protobuf specification.
    (Tag, Length, Value)
    Wire type for string is 2 (Length-delimited).
    """
    # Tag is (field_number << 3) | wire_type (2 for length-delimited)
    tag = (field_number << 3) | 2
    tag_bytes = _encode_varint(tag)
    value_bytes = value.encode("utf-8")
    length_bytes = _encode_varint(len(value_bytes))
    return tag_bytes + length_bytes + value_bytes


def _get_base64_protobuf(message: dict) -> str:
    """
    Encodes a simple Protobuf message `{ param1: string, param2: string }`
    into a base64-encoded protobuf byte string.
    Corresponds to the JS `getBase64Protobuf` function.
    """
    buffer = bytearray()
    if "param1" in message and message["param1"] is not None:
        buffer.extend(_encode_string_field(1, message["param1"]))
    if "param2" in message and message["param2"] is not None:
        buffer.extend(_encode_string_field(2, message["param2"]))

    return base64.b64encode(buffer).decode("utf-8")


# --- YouTube Data API Functions ---


def _get_default_subtitle_language(video_id: str) -> dict:
    """
    Returns the default subtitle language of a video on YouTube.
    Requires a valid `youtube_client` (YouTube Data API key).
    """
    if youtube_client is None:
        raise Exception(
            "YouTube Data API client is not initialized. "
            "Cannot fetch default subtitle language without a valid API key."
        )

    # Get video default language
    videos_response = (
        youtube_client.videos().list(part="snippet", id=video_id).execute()
    )

    if not videos_response.get("items"):
        raise Exception(f"No video found for ID: {video_id}")

    if len(videos_response["items"]) != 1:
        raise Exception(f"Multiple videos found for video: {video_id}")

    video_snippet = videos_response["items"][0]["snippet"]
    # Prioritize defaultLanguage, then defaultAudioLanguage
    preferred_language = video_snippet.get("defaultLanguage") or video_snippet.get(
        "defaultAudioLanguage"
    )

    # Get available subtitles
    subtitles_response = (
        youtube_client.captions().list(part="snippet", videoId=video_id).execute()
    )

    if not subtitles_response.get("items"):
        raise Exception(f"No subtitles found for video: {video_id}")

    # Find the preferred language or default to the first available subtitle track
    found_subtitle = None
    if preferred_language:
        for sub in subtitles_response["items"]:
            if sub["snippet"]["language"] == preferred_language:
                found_subtitle = sub
                break

    if not found_subtitle:
        found_subtitle = subtitles_response["items"][
            0
        ]  # Fallback to the first available track

    track_kind = found_subtitle["snippet"]["trackKind"]
    language = found_subtitle["snippet"]["language"]

    return {"trackKind": track_kind, "language": language}


# --- InnerTube API Helper Functions ---


def _extract_text(item: dict) -> str:
    """
    Helper function to extract text from certain elements in the InnerTube API response.
    """
    if "simpleText" in item:
        return item["simpleText"]
    elif "runs" in item and item["runs"]:
        return "".join(run["text"] for run in item["runs"])
    return ""


def _get_subtitles_from_innertube(
    video_id: str, track_kind: str, language: str
) -> list[dict]:
    """
    Function to retrieve subtitles for a given YouTube video using InnerTube API.
    """
    # Construct the inner protobuf message for track info
    inner_message = {
        "param2": language,  # language is typically param2
    }
    # Only include `trackKind` for automatically-generated subtitles ('asr') as param1
    if track_kind == "asr":
        inner_message["param1"] = track_kind

    encoded_inner_message = _get_base64_protobuf(inner_message)

    # Construct the outer protobuf message for the request parameters
    outer_message = {
        "param1": video_id,
        "param2": encoded_inner_message,
    }
    params = _get_base64_protobuf(outer_message)

    url = "https://www.youtube.com/youtubei/v1/get_transcript"
    headers = {"Content-Type": "application/json"}

    # The 'clientVersion' is crucial and YouTube often updates it.
    # If the script stops working, you might need to update this version
    # by inspecting network requests on a live YouTube video page.
    data = {
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20240826.01.00",  # Used from original JS code
            },
        },
        "params": params,
    }

    response = requests.post(url, json=data, headers=headers)
    response.raise_for_status()  # Raises an exception for HTTP errors (4xx or 5xx)
    response_data = response.json()

    # Accessing deep nested dictionary keys based on the YouTube InnerTube API response structure.
    # This structure is subject to change by YouTube.
    try:
        initial_segments = response_data["actions"][0]["updateEngagementPanelAction"][
            "content"
        ]["transcriptRenderer"]["content"]["transcriptSearchPanelRenderer"]["body"][
            "transcriptSegmentListRenderer"
        ][
            "initialSegments"
        ]
    except (KeyError, IndexError) as e:
        raise TranscriptNotFoundError(video_id)

    if not initial_segments:
        raise TranscriptNotFoundError(video_id)

    output = []
    for segment in initial_segments:
        # A segment can be a header or a transcript line
        line = segment.get("transcriptSectionHeaderRenderer") or segment.get(
            "transcriptSegmentRenderer"
        )

        if not line:
            # Skip items that are not standard transcript lines (e.g., placeholders)
            continue

        start_ms = line.get("startMs")
        end_ms = line.get("endMs")
        snippet = line.get("snippet")

        if start_ms is None or end_ms is None or snippet is None:
            # Ensure all expected fields are present for a valid transcript line
            print(f"Warning: Skipping malformed segment in video {video_id}: {segment}")
            continue

        text = _extract_text(snippet)

        output.append(
            {
                "text": text,
                "start": int(start_ms) / 1000,
                "duration": (int(end_ms) - int(start_ms)) / 1000,
            }
        )

    return output


# --- Public API Function ---


def fetch_transcript(video_id: str) -> list[dict]:
    """
    Fetches the transcript for a given YouTube video ID.

    Args:
        video_id (str): The ID of the YouTube video.

    Returns:
        list[dict]: A list of dictionaries, where each dictionary represents
                    a transcript segment and has the keys 'text', 'start',
                    and 'duration'.

    Raises:
        Exception: If any error occurs during the fetching process,
                   e.g., video not found, no subtitles, API key issues,
                   or YouTube InnerTube API response structure changes.
    """
    try:
        # Try to get the default language using YouTube Data API
        lang_info = _get_default_subtitle_language(video_id)
        language = lang_info["language"]
        track_kind = lang_info["trackKind"]
    except Exception as e:
        # If YouTube Data API fails (e.g., no API key, or general API error),
        # try to fallback to a common language like 'en' (English) and 'standard' track.
        # This might not always work but provides a graceful degradation.
        print(
            f"Warning: Failed to determine default language via YouTube Data API ({e}). "
            "Attempting to fetch with default 'en' (English) language and 'standard' track kind."
        )
        language = "en"
        track_kind = "standard"  # Or 'asr' if auto-generated is preferred

    return _get_subtitles_from_innertube(
        video_id=video_id, language=language, track_kind=track_kind
    )


# --- Example Usage (when run as a script) ---
if __name__ == "__main__":
    if YOUTUBE_API_KEY == "<YOUR-YOUTUBE-API-KEY>":
        print("\n" * 2)
        print(
            "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
        )
        print(
            "!!! WARNING: Please replace '<YOUR-YOUTUBE-API-KEY>' in the script         !!!"
        )
        print(
            "!!!          or set the 'YOUTUBE_API_KEY' environment variable.            !!!"
        )
        print(
            "!!!          The script cannot fully proceed without a valid YouTube Data API Key. !!!"
        )
        print(
            "!!!          'getDefaultSubtitleLanguage' will fail, and a fallback to 'en' is used. !!!"
        )
        print(
            "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
        )
        print("\n" * 2)

    example_video_ids = [
        "pyX8kQ-JzHI",  # Video with ASR captions
        "-16RFXr44fY",  # Video with uploaded captions
        "qwQwSTWHTAY",  # Video with multiple caption tracks (`defaultAudioLanguage: 'ru'`)
        "dQw4w9WgXcQ",  # A very common video (Rick Astley - Never Gonna Give You Up)
        # 'NON_EXISTENT_VIDEO_ID' # Uncomment to test error handling
    ]

    for video_id in example_video_ids:
        print(f"--- Fetching transcript for video ID: {video_id} ---")
        try:
            transcript_data = fetch_transcript(video_id)
            print(f"Successfully fetched {len(transcript_data)} transcript segments.")
            print("\n--- Transcript Snippet (first 5 lines) ---")
            for i, line in enumerate(transcript_data):
                if i >= 5:
                    break
                # Format to match requested output: {text, start, duration}
                print(
                    f"  {{'text': '{line['text'][:50]}...', 'start': {line['start']:.2f}, 'duration': {line['duration']:.2f}}}"
                )

            # If you want to see the full JSON output:
            # print("\n--- Full JSON Output (truncated for brevity) ---")
            # print(json.dumps(transcript_data[:5], indent=2)) # Print only first 5 segments as JSON
            # print("...")

        except Exception as e:
            print(f"ERROR: Could not fetch transcript for {video_id}: {e}")
        print("-" * 60 + "\n")
