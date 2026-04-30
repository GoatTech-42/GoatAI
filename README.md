# GoatAI API Chat

A multi-provider AI studio for chat, image, audio, and agent tasks. Runs locally with a modern web UI.

## Features
- Supports many AI providers (OpenAI, Anthropic, Groq, etc.)
- Free and keyless options available
- Image, chat, and audio generation
- Local WebGPU models included

## Getting Started
1. Install Python 3.10+
2. Install dependencies:
   ```sh
   pip install flask requests
   ```
3. Run the server:
   ```sh
   python app.py
   ```
4. Open your browser at [http://127.0.0.1:5000](http://127.0.0.1:5000)

## Configuration
- Edit `config.json` to add API keys for paid providers (optional)
- All data is stored locally

## Folders
- `API Chat/` — main app and frontend
- `generated/` — generated images/audio

## License
MIT
