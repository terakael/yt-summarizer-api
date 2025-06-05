from abc import ABC, abstractmethod
import os
import asyncio
from typing import AsyncIterator

import google.generativeai as genai
from google.generativeai.types import HarmCategory, HarmBlockThreshold # For safety settings
from openai import OpenAI, AsyncOpenAI # Import AsyncOpenAI for streaming

# Helper to print errors clearly
def print_error(message):
    print(f"\033[91mERROR: {message}\033[0m")

class LLMProvider(ABC):
    @abstractmethod
    def generate_content(self, prompt: str, content: str) -> str:
        """
        Generate content based on system prompt and input content (non-streaming).
        Args:
            prompt: System prompt/instructions
            content: Input content to process
        Returns:
            Generated content from LLM
        """
        pass

    @abstractmethod
    async def generate_content_stream(self, prompt: str, content: str) -> AsyncIterator[str]:
        """
        Generate content based on system prompt and input content (streaming).
        Args:
            prompt: System prompt/instructions
            content: Input content to process
        Yields:
            Generated content chunks from LLM
        """
        # This is an async generator, abstract method needs a body that makes it one.
        if False: # Will be overridden by concrete implementations
            yield ""


class GeminiProvider(LLMProvider):
    def __init__(self) -> None:
        self.model_name = os.getenv("GEMINI_MODEL")
        if not self.model_name:
            print_error("GEMINI_MODEL environment variable not set.")
            raise ValueError("GEMINI_MODEL environment variable not set.")
        
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            print_error("GEMINI_API_KEY environment variable not set.")
            raise ValueError("GEMINI_API_KEY environment variable not set.")
        
        genai.configure(api_key=api_key)
        
        # System instruction can be set at model initialization for newer models/versions
        # For now, we'll include it in the combined content string as per current usage.
        self.model = genai.GenerativeModel(self.model_name)

        # Optional: Configure safety settings to be less restrictive if needed.
        # This can help avoid empty responses if content is borderline.
        # Use with caution and understand the implications.
        self.safety_settings = {
            HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_NONE,
            HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_NONE,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_NONE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_NONE,
        }
        # To disable safety settings (use with extreme caution):
        # self.safety_settings = None 
        # To use default safety settings:
        # self.safety_settings = {} # Or don't pass safety_settings to generate_content

    def generate_content(self, prompt: str, content: str) -> str:
        try:
            # For some models, system prompt can be passed via `system_instruction`
            # Here we combine them as the Quart app currently does.
            full_prompt = f"{prompt}\n\n{content}"
            response = self.model.generate_content(
                full_prompt,
                safety_settings=self.safety_settings if self.safety_settings else None 
            )
            return response.text
        except Exception as e:
            print_error(f"Gemini non-streaming error: {e}")
            # Check for specific Gemini block reasons if possible
            if hasattr(e, 'response') and hasattr(e.response, 'prompt_feedback'):
                 if e.response.prompt_feedback.block_reason:
                    raise ValueError(f"Content generation blocked. Reason: {e.response.prompt_feedback.block_reason.name}") from e
            raise  # Re-raise the original exception or a more specific one

    async def generate_content_stream(self, prompt: str, content: str) -> AsyncIterator[str]:
        # The Gemini SDK's stream is a synchronous iterator.
        # We run the blocking part (getting the next item) in a thread pool.
        full_prompt = f"{prompt}\n\n{content}"
        
        try:
            sync_iterator = self.model.generate_content(
                full_prompt,
                stream=True,
                safety_settings=self.safety_settings if self.safety_settings else None
            )
            loop = asyncio.get_event_loop()

            while True:
                try:
                    # Run the blocking sync_iterator's next() in a thread
                    response_chunk = await loop.run_in_executor(None, next, sync_iterator)
                    
                    # Check for prompt feedback (e.g., if the prompt itself was blocked)
                    if response_chunk.prompt_feedback and \
                       response_chunk.prompt_feedback.block_reason != genai.types.BlockReason.BLOCK_REASON_UNSPECIFIED:
                        error_message = f"Gemini prompt blocked. Reason: {response_chunk.prompt_feedback.block_reason.name}"
                        print_error(error_message)
                        raise Exception(error_message) # This will be caught by the outer try-except

                    chunk_text = ""
                    # A candidate might be blocked, check finish_reason
                    for candidate in response_chunk.candidates:
                        if candidate.finish_reason == genai.types.Candidate.FinishReason.SAFETY:
                            # This specific candidate chunk was blocked due to safety
                            safety_ratings_info = ", ".join([f"{rating.category.name}: {rating.probability.name}" for rating in candidate.safety_ratings])
                            block_msg = f"Gemini content chunk blocked (Safety). Ratings: [{safety_ratings_info}]"
                            print_error(block_msg)
                            # Optionally yield an error message or raise. Raising is cleaner for Quart handler.
                            raise Exception(block_msg) 

                        if candidate.content and candidate.content.parts:
                            for part in candidate.content.parts:
                                if hasattr(part, 'text') and part.text:
                                    chunk_text += part.text
                    
                    if chunk_text:
                        yield chunk_text

                except StopIteration:
                    # Normal end of the stream
                    break
                except Exception as e: # Catch errors from run_in_executor or inside the loop
                    # This will catch prompt_feedback errors or safety blocks raised above
                    print_error(f"Error during Gemini stream chunk processing: {e}")
                    raise # Re-raise to be handled by the Quart endpoint

        except Exception as e: # Catch errors from the initial generate_content call
            print_error(f"Error setting up Gemini stream: {e}")
            # This could be an API connection error, auth error, or prompt_feedback from initial call
            # For example, if the entire prompt is immediately rejected by safety filters
            if hasattr(e, 'message') and "prompt_feedback" in e.message.lower(): # Heuristic
                 # Extract more specific feedback if possible, though SDK might raise generic error
                 pass # Error already printed
            raise # Re-raise to be handled by the Quart endpoint


class OpenAIProvider(LLMProvider):
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY")
        self.base_url = os.getenv("OPENAI_BASE_URL") 
        self.model_name = os.getenv("OPENAI_MODEL")

        if not self.api_key:
            print_error("OPENAI_API_KEY environment variable not set.")
            raise ValueError("OPENAI_API_KEY environment variable not set.")
        if not self.model_name:
            print_error("OPENAI_MODEL environment variable not set.")
            raise ValueError("OPENAI_MODEL environment variable not set.")

        # Synchronous client for non-streaming methods
        self.llm = OpenAI(api_key=self.api_key, base_url=self.base_url)
        # Asynchronous client for streaming methods
        self.async_llm = AsyncOpenAI(api_key=self.api_key, base_url=self.base_url)
        # Note: For production, self.async_llm should be properly closed on app shutdown.
        # Quart's app.shutdown or app.after_serving can be used.

    def generate_content(self, prompt: str, content: str) -> str:
        try:
            response = self.llm.chat.completions.create(
                model=self.model_name,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": content},
                ],
            )
            return response.choices[0].message.content
        except Exception as e:
            print_error(f"OpenAI non-streaming error: {e}")
            raise

    async def generate_content_stream(self, prompt: str, content: str) -> AsyncIterator[str]:
        try:
            stream = await self.async_llm.chat.completions.create(
                model=self.model_name,
                messages=[
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": content},
                ],
                stream=True
            )
            async for chunk in stream:
                if chunk.choices:
                    delta = chunk.choices[0].delta
                    if delta and delta.content is not None:
                        yield delta.content
                    # Check for finish reason if needed, e.g., length, content_filter
                    if chunk.choices[0].finish_reason:
                        # print(f"OpenAI stream finished. Reason: {chunk.choices[0].finish_reason}")
                        if chunk.choices[0].finish_reason == "content_filter":
                            block_msg = "OpenAI content chunk blocked (Content Filter)."
                            print_error(block_msg)
                            raise Exception(block_msg) # Notify client
                        break # Stop iteration if a terminal finish_reason is received
        except Exception as e:
            print_error(f"Error during OpenAI stream: {e}")
            raise # Re-raise to be handled by the Quart endpoint


def get_llm_provider() -> LLMProvider:
    provider_name = os.getenv("LLM_PROVIDER", "openai").lower() # Default to openai for wider compatibility
    print(f"Attempting to initialize LLM provider: {provider_name}")
    if provider_name == "gemini":
        print("Initializing GeminiProvider...")
        return GeminiProvider()
    elif provider_name == "openai":
        print("Initializing OpenAIProvider...")
        return OpenAIProvider()
    else:
        print_error(f"Unsupported LLM provider: {provider_name}")
        raise ValueError(f"Unsupported LLM provider: {provider_name}")
