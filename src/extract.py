import os
import email
import time
import json
from email.policy import default
import instructor
from groq import Groq

# We import our upgraded blueprint
from schema import ExtractedMemory

# --- 1. SETUP THE SYSTEM ---
# SECURITY FIX: Never hardcode API keys. Read from the environment.
# Make sure to run `export GROQ_API_KEY="your_key"` in your terminal before running this.
GROQ_API_KEY = os.getenv("GROQ_API_KEY") 
if not GROQ_API_KEY:
    raise ValueError("GROQ_API_KEY environment variable is missing!")

MODEL_NAME = "llama-3.3-70b-versatile"
SCHEMA_VERSION = "v1.0"

client = instructor.from_groq(Groq(api_key=GROQ_API_KEY))

# --- 2. ENVELOPE OPENER (With Temporal Data) ---
def parse_enron_file(filepath):
    """
    Extracts the Message-ID (Source ID) and Date (Temporal anchor).
    """
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        msg = email.message_from_file(f, policy=default)
        
        msg_id = msg.get('Message-ID', 'UNKNOWN').strip()
        msg_date = msg.get('Date', 'UNKNOWN').strip()
        
        body_parts = []
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                body_parts.append(part.get_payload(decode=True).decode('utf-8', errors='ignore'))
        body = "\n".join(body_parts) if body_parts else ""

        return msg_id, msg_date, str(body)

# --- 3. THE EXTRACTION ENGINE (With Quality Gates) ---
def extract_memory(msg_id, msg_date, letter_text):
    """
    Forces the AI to fill out the schema, including self-evaluated confidence.
    """
    print(f"-> Extracting: {msg_id}")
    
    return client.chat.completions.create(
        model=MODEL_NAME,
        response_model=ExtractedMemory,
        temperature=0.05,
        max_tokens=4000,
        messages=[
            {
                "role": "system", 
                "content": (
                    "You are an exhaustive data extractor for a long-term memory system. "
                    "Extract EVERY relationship and entity. "
                    "STRICT RULE: Do not add fields not in the schema. "
                    "GROUNDING: You must use exact quotes and provide context on where in the text "
                    "the info was found (e.g. 'Paragraph 1')."
                )
            },
            {
                "role": "user", 
                "content": f"Ver: {SCHEMA_VERSION}\nID: {msg_id}\nDate: {msg_date}\n\nText:\n{letter_text}"
            }
        ]
    )

# --- 4. BATCH PIPELINE ---
if __name__ == "__main__":
    test_folder = "data/raw/subset/lay-k/" 
    
    # SAFETY FIX: Ensure output directories exist before writing
    os.makedirs("data", exist_ok=True)
    
    all_memories = []
    failed_extractions = []
    
    if not os.path.exists(test_folder):
        print(f"Error: Could not find the folder '{test_folder}'. Please check your path.")
        exit(1)

    files = [f for f in os.listdir(test_folder) if os.path.isfile(os.path.join(test_folder, f))]
    
    for filename in files:
        full_path = os.path.join(test_folder, filename)
        
        msg_id, msg_date, body = parse_enron_file(full_path)
        
        try:
            # Slicing the body to prevent context window overflow
            memory = extract_memory(msg_id, msg_date, body[:2000])
            memory.metadata.extraction_version = SCHEMA_VERSION
            memory.metadata.model_name = MODEL_NAME
            all_memories.append(memory.model_dump())
            print(f"   [Success] Data grounded in {msg_id}")
        except Exception as e:
            print(f"   [Validation Failed] {msg_id}: {e}")
            failed_extractions.append({"file": filename, "msg_id": msg_id, "error": str(e)})

        # Rate Limit Management
        time.sleep(3)

    # 5. Serialization 
    output_path = "data/extracted_memories.json"
    with open(output_path, "w") as f:
        json.dump(all_memories, f, indent=2)
    
    with open("data/failed_extractions.json", "w") as f:
        json.dump(failed_extractions, f, indent=2)
        
    print(f"\nPipeline Complete. Memories saved to {output_path}")