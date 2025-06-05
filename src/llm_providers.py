from abc import ABC, abstractmethod
import os
import google.generativeai as genai
from openai import OpenAI


class LLMProvider(ABC):
    @abstractmethod
    def generate_content(self, prompt: str, content: str) -> str:
        """
        Generate content based on system prompt and input content
        Args:
            prompt: System prompt/instructions
            content: Input content to process
        Returns:
            Generated content from LLM
        """
        pass


class GeminiProvider(LLMProvider):
    def __init__(self) -> None:
        self.model = os.getenv("GEMINI_MODEL")
        genai.configure(api_key=os.getenv("GEMINI_API_KEY"))

    def generate_content(self, prompt: str, content: str) -> str:
        model = genai.GenerativeModel(self.model)
        response = model.generate_content(f"{prompt}\n\n{content}")
        return response.text


class OpenAIProvider(LLMProvider):
    def __init__(self):
        self.llm = OpenAI(
            api_key=os.getenv("OPENAI_API_KEY"), base_url=os.getenv("OPENAI_BASE_URL")
        )

        self.model = os.getenv("OPENAI_MODEL")

    def generate_content(self, prompt: str, content: str) -> str:
        response = self.llm.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": content},
            ],
        )
        return response.choices[0].message.content


def get_llm_provider() -> LLMProvider:
    provider = os.getenv("LLM_PROVIDER", "gemini").lower()
    if provider == "gemini":
        return GeminiProvider()
    elif provider == "openai":
        return OpenAIProvider()
    else:
        raise ValueError(f"Unsupported LLM provider: {provider}")
