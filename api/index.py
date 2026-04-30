# Vercel serverless entrypoint — imports the Flask app from app.py (one level up).
# Vercel's @vercel/python runtime discovers the WSGI app via the `app` or
# `application` variable in this file.

import sys
import os

# Make the repo root importable so `from app import app` works even when the
# working directory is the `api/` sub-folder.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    from app import app          # preferred name Vercel looks for
    application = app            # alias for compatibility
except Exception as exc:
    from flask import Flask, jsonify
    app = Flask(__name__)
    application = app

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def _import_error(path=""):
        return jsonify({"error": {"type": "internal",
                                  "message": f"Failed to import app.py: {exc}"}}), 500
