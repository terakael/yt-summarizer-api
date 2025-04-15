# YouTube Summarizer API

A Quart-based API that summarizes YouTube videos using Google's Gemini AI.

## Requirements
- Python 3.10+
- UV package manager (recommended)

## Installation
1. Create virtual environment:
```bash
uv venv .venv
```

2. Activate virtual environment:
```bash
source .venv/bin/activate
```

3. Install dependencies:
```bash
uv pip install -r requirements.txt
```

4. Install compatible Werkzeug version:
```bash
uv pip install "werkzeug<3.0.0"
```

## Configuration
Set required environment variables:
```bash
export GEMINI_API_KEY=your_api_key_here
```

## Running the API
```bash
python main.py
```

## API Endpoints
- `POST /summarize` - Summarize a YouTube video
  - Request body: `{"url": "youtube_video_url"}`
  - Response: 
    ```json
    {
      "video_id": "extracted_id",
      "summary": "generated_summary"
    }
    ```

## Error Handling
- 400: Missing URL parameter
- 404: Transcript not available
- 500: Server error (missing API key or other issues)

## Example Usage
```bash
curl -X POST http://localhost:5000/summarize \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'