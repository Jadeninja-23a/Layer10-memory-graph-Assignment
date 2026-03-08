import os
import email
import time
import json
from email.policy import default
import instructor
from openai import OpenAI
import concurrent.futures

# We import our upgraded blueprint
from schema import ExtractedMemory

# --- 1. SETUP THE LOCAL SYSTEM ---
MODEL_NAME = "llama3.1"
SCHEMA_VERSION = "v1.0"

print("Connecting to local Ollama engine...")
# We point the OpenAI client at your laptop's local port.
# The api_key is required by the library, but Ollama ignores it, so "ollama" is fine.
client = instructor.from_openai(
    OpenAI(
        base_url="http://localhost:11434/v1",
        api_key="ollama", 
    ),
    mode=instructor.Mode.JSON,
)

# --- 2. ENVELOPE OPENER ---
def parse_enron_file(filepath):
    """Extracts the Message-ID and Date."""
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

# --- 3. THE EXTRACTION ENGINE ---
def extract_memory(msg_id, msg_date, letter_text):
    """
    Forces the local LLaMA model to output valid JSON.
    """
    print(f"-> Extracting: {msg_id}")
    
    return client.chat.completions.create(
        model=MODEL_NAME,
        response_model=ExtractedMemory,
        temperature=0.05,
        messages=[
            {
                "role": "system", 
                "content": (
                    "You are a precise data extractor for a corporate long-term memory system. "
                    "Extract the core business relationships. Limit your extraction to a MAXIMUM of 10 "
                    "entities to focus only on the most critical signal and prevent memory overload. "
                    "If the text appears to be a mass newsletter, spam, or a news article, extract NOTHING "
                    "and return empty arrays. "
                    "STRICT RULE: Do not add fields not in the schema. "
                    "GROUNDING: You must use exact quotes and provide context on where in the text "
                    "the info was found (e.g., 'Paragraph 1')."
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
    import concurrent.futures # ADD THIS AT THE TOP OF YOUR FILE
    
    test_folder = "data/raw/subset/lay-k/" 
    os.makedirs("data", exist_ok=True)
    
    all_memories = []
    failed_extractions = []
    
    files = [f for f in os.listdir(test_folder) if os.path.isfile(os.path.join(test_folder, f))]
    start_time = time.time()
    
    for filename in files:
        full_path = os.path.join(test_folder, filename)
        msg_id, msg_date, body = parse_enron_file(full_path)
        
        try:
            # 1. We manually create the executor (NO 'with' block!)
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            clean_body = body[:2000].rsplit(' ', 1)[0]
            
            # 2. Submit the task
            future = executor.submit(extract_memory, msg_id, msg_date, clean_body)
            
            # 3. Wait exactly 60 seconds
            memory = future.result(timeout=60)
            
            # 4. If it succeeds, cleanly shut down the thread
            executor.shutdown(wait=False)
            
            memory.metadata.extraction_version = SCHEMA_VERSION
            memory.metadata.model_name = "local-" + MODEL_NAME
            all_memories.append(memory.model_dump())
            print(f"   [Success] Data grounded in {msg_id}")
            
        except concurrent.futures.TimeoutError:
            print(f"   [TIMEOUT KILL] Model got stuck on {msg_id}. Abandoning thread!")
            # THIS IS THE FIX: Tell Python to walk away and NOT wait for the thread to finish.
            executor.shutdown(wait=False) 
            failed_extractions.append({"file": filename, "msg_id": msg_id, "error": "Execution Timeout (>60s)"})
        except Exception as e:
            print(f"   [Validation Failed] {msg_id}: {e}")
            executor.shutdown(wait=False)
            failed_extractions.append({"file": filename, "msg_id": msg_id, "error": str(e)})

    # 5. Serialization 
    output_path = "data/extracted_memories_local.json"
    with open(output_path, "w") as f:
        json.dump(all_memories, f, indent=2)
    
    with open("data/failed_extractions_local.json", "w") as f:
        json.dump(failed_extractions, f, indent=2)
        
    elapsed = time.time() - start_time
    print(f"\nPipeline Complete in {elapsed:.1f}s. Memories saved to {output_path}")
    os._exit(0)
# # --- 4. BATCH PIPELINE ---
# if __name__ == "__main__":
#     test_folder = "data/raw/subset/lay-k/" 
#     os.makedirs("data", exist_ok=True)
    
#     all_memories = []
#     failed_extractions = []
    
#     if not os.path.exists(test_folder):
#         print(f"Error: Could not find '{test_folder}'.")
#         exit(1)

#     files = [f for f in os.listdir(test_folder) if os.path.isfile(os.path.join(test_folder, f))]
    
#     # Let's track how long local extraction takes
#     start_time = time.time()
    
#     for filename in files:
#         full_path = os.path.join(test_folder, filename)
#         msg_id, msg_date, body = parse_enron_file(full_path)
        
#         # Replace your current try/except block in the main loop with this:
#         try:
#             # We use a thread to enforce a 60-second execution limit
#             with concurrent.futures.ThreadPoolExecutor() as executor:
#                 # Slices at 2500, then splits at the last space to ensure a clean word break
#                 clean_body = body[:2500].rsplit(' ', 1)[0]
#                 future = executor.submit(extract_memory, msg_id, msg_date, clean_body)
#                 # If it takes longer than 60 seconds, this raises a TimeoutError
#                 memory = future.result(timeout=60)
                
#             memory.metadata.extraction_version = SCHEMA_VERSION
#             memory.metadata.model_name = "local-" + MODEL_NAME
#             all_memories.append(memory.model_dump())
#             print(f"   [Success] Data grounded in {msg_id}")
            
#         except concurrent.futures.TimeoutError:
#             print(f"   [Timeout] Model got stuck in an infinite loop on {msg_id}. Skipping.")
#             failed_extractions.append({"file": filename, "msg_id": msg_id, "error": "Execution Timeout (>60s)"})
#         except Exception as e:
#             print(f"   [Validation Failed] {msg_id}: {e}")
#             failed_extractions.append({"file": filename, "msg_id": msg_id, "error": str(e)})

#     # 5. Serialization 
#     output_path = "data/extracted_memories_local.json"
#     with open(output_path, "w") as f:
#         json.dump(all_memories, f, indent=2)
    
#     with open("data/failed_extractions_local.json", "w") as f:
#         json.dump(failed_extractions, f, indent=2)
        
#     elapsed = time.time() - start_time
#     print(f"\nPipeline Complete in {elapsed:.1f}s. Memories saved to {output_path}")