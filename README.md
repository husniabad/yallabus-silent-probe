# Mishwari Silent Probe (Gemini Edition) 🕵️‍♂️

This is a standalone, read-only WhatsApp listener that extracts trip data using Google Gemini and pushes it to the Mishwari Backend.

## 🚀 Setup & Run

1.  **Configure Environment**:
    Edit `.env` and fill in your values (API Keys only, Groups are now in `groups.config.json`):
    ```env
    MISHWARI_API_URL=http://localhost:8000/api/fleet-manager/shadow-trips/
    GEMINI_API_KEY=AIzaSy...
    MISHWARI_API_KEY=your_backend_key
    ```

2.  **Discover Group IDs** (New):
    Run this tool to see the IDs of all groups you are in:
    ```bash
    node list-groups.js
    ```

3.  **Configure Routing**:
    Edit `groups.config.json` to assign specific operators to groups:
    ```json
    {
      "groups": {
        "123...456@g.us": { "operator_id": "OP_SANAA", "name": "Sana'a Drivers" }
      },
      "default": { "operator_id": "OP_GENERAL" }
    }
    ```

4.  **Start the Probe**:
    ```bash
    node monitor.js
    ```

## 🛠 Features
-   **Silent**: No reply capability.
-   **Smart**: Uses **Gemini 1.5 Flash** for fast, structured JSON extraction.
-   **Routed**: Assigns trips to specific operators based on the WhatsApp group.
