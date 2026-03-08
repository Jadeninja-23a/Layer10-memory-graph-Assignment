## How to Run (End-to-End Reproducibility)

This pipeline is designed to be fully reproducible from a fresh clone. Follow these steps to download the public corpus, run the AI extraction, and start the visualization server.

### Step 0: Download the Corpus
We use the official CMU Enron Email Dataset. To keep the extraction time manageable for testing, we will specifically target Kenneth Lay's `all_documents` mailbox. 

Run these commands in your terminal to download and position the data:
```bash
# 1. Create the target directory
mkdir -p data/raw/subset/

# 2. Download the CMU Enron dataset (Warning: ~400MB)
wget https://www.cs.cmu.edu/~enron/enron_mail_20150507.tar.gz

# 3. Extract ONLY Kenneth Lay's mailbox to save time and space
# Note: You can extract other mailboxes here, but Groq API credit limits and slow local models make full extractions difficult.
tar -xzf enron_mail_20150507.tar.gz maildir/lay-k/all_documents/

# 4. Move the folder into our project structure and clean up
mv maildir/lay-k/all_documents/ data/raw/subset/lay-k/
rm -rf maildir/ enron_mail_20150507.tar.gz

# 5. TEST RUN RECOMMENDATION: 
# Since a full mailbox is still too large, delete most files in data/raw/subset/lay-k/ and keep only ~20 emails for your first test.
```

If you choose to extract a different user's mailbox or want to change your data source, simply replace the test_folder variable in the __main__ block of `src/extract.py` (and `src/llama_extract.py`).

```python
if __name__ == "__main__":
    # Change this path to point to whichever folder you want to process
    test_folder = "data/raw/subset/lay-k/" 
    
    # SAFETY FIX: Ensure output directories exist before writing
    os.makedirs("data", exist_ok=True)
    
    all_memories = []
    failed_extractions = []
    
    if not os.path.exists(test_folder):
        print(f"Error: Could not find the folder '{test_folder}'. Please check your path.")
        exit(1)

    # Grabs the files for extraction. 
    # TIP: You can easily limit your test size here by slicing the array: files[:20]
    files = [f for f in os.listdir(test_folder) if os.path.isfile(os.path.join(test_folder, f))]
```

## Prerequisites
Install the required libraries:
```bash
pip install instructor pydantic groq openai thefuzz flask flask-cors
```

Set your Groq API key in your terminal before running:
```bash 
export GROQ_API_KEY="your_api_key_here"
```

## Execution Steps
Run the pipeline from the root directory in this order:

### 1. Extract the Data
Read the raw emails and extract JSON relationships.

```Bash
python src/extract.py
```
(Generates data/extracted_memories.json)

### 2. Resolve & Deduplicate
Merge aliases, drop ghosts, and apply blocklists.

```Bash
python src/resolve.py
```
(Generates data/resolved_memories.json and data/resolution_audit.json)

### 3. Build the Graph
Package the resolved data for the UI.

```Bash
python src/graph.py
```
(Generates data/graph.json)

### 4. Start the Web Server
Start the Flask backend to serve the UI and handle background rebuilds.

```Bash
python src/server.py
```
Open your browser and navigate to http://localhost:5050.