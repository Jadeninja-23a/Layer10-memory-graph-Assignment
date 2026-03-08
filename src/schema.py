from pydantic import BaseModel, Field, field_validator
from typing import List

# --- NEW: VERSIONING ---
# Layer10 wants to know how we track schema drift. We add a Metadata envelope.
class ExtractionMetadata(BaseModel):
    extraction_version: str = Field(description="The version of the prompt/schema used (e.g., 'v1.0').")
    model_name: str = Field(description="The LLM used for extraction (e.g., 'llama-3.3-70b-versatile').")

# --- UPGRADED: GROUNDING ---
# We add timestamp and location context to satisfy the strict grounding requirement.
class Evidence(BaseModel):
    source_id: str = Field(description="The Message-ID from the email header.")
    exact_quote: str = Field(description="The EXACT, word-for-word quote from the text.")
    timestamp: str = Field(description="The Date the email was sent (from the email header).")
    context_location: str = Field(description="Briefly describe where this was found (e.g., 'Subject line', 'Paragraph 2', 'Forwarded thread').")

class Entity(BaseModel):
    name: str = Field(description="The primary name of the person, project, or organization.")
    entity_type: str = Field(description="Must be: PERSON, PROJECT, or ORGANIZATION.")

# --- UPGRADED: QUALITY GATES ---
# We add a confidence score. Later, we can tell our graph database to IGNORE 
# any relationship with a score lower than 0.8.
class Relationship(BaseModel):
    source: str = Field(description="The name of the entity doing the action.")
    action: str = Field(description="The verb connecting them.")
    target: str = Field(description="The name of the entity receiving the action.")
    confidence_score: float = Field(description="A score from 0.0 to 1.0 indicating how certain you are this relationship is factual.")
    
    @field_validator('confidence_score')
    @classmethod
    def score_must_be_in_range(cls, v):
        if not 0.0 <= v <= 1.0:
            raise ValueError('confidence_score must be between 0.0 and 1.0')
        return v
    proof: List[Evidence] = Field(description="The exact quotes from the text that prove this relationship exists.")

class ExtractedMemory(BaseModel):
    metadata: ExtractionMetadata = Field(description="Tracking information for this extraction run.")
    entities: List[Entity] = Field(description="A list of all the nouns found in the text.")
    relationships: List[Relationship] = Field(description="A list of all the verbs connecting those nouns.")