# Lightweight Vercel function entrypoint that exposes the Flask app from the repository
# Vercel expects a top-level `app`, `application`, or `handler` variable in the entry file.
# We import the project's `app` and expose it as `application`.
# If importing fails (e.g. due to runtime mismatch), provide a minimal fallback app that
# returns the import error so the deployment can start and surface the real issue.

try:
    from app import app as application  # import the Flask app defined in app.py
except Exception as e:
    # If importing the real app fails, expose a minimal app that returns the error.
    from flask import Flask
    application = Flask(__name__)

    @application.route("/")
    def _import_error():
        return (f"Failed to import project app.py: {e}", 500)
