# Vercel serverless entrypoint — imports the Flask app from app.py (one level up).
#
# Vercel's @vercel/python runtime discovers the WSGI app via a top-level
# `app`, `application`, or `handler` variable in this file.  We therefore
# expose all three names so the runtime can pick whichever it expects.
#
# If the import of `app` fails for any reason (missing dep, syntax error,
# corrupt bundle), we fall back to a tiny Flask app that returns a clean JSON
# 500 instead of letting the function crash with FUNCTION_INVOCATION_FAILED.

import os
import sys
import traceback

# Make the repo root importable so `from app import app` works even when the
# working directory is the `api/` sub-folder.
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

try:
    from app import app  # noqa: E402 — top-level Flask WSGI app discovered by Vercel
except Exception as _import_err:  # pragma: no cover — last-resort safety net
    traceback.print_exc()
    _err_text = f"{type(_import_err).__name__}: {_import_err}"

    try:
        from flask import Flask, jsonify

        app = Flask(__name__)

        @app.route("/", defaults={"path": ""}, methods=["GET", "POST", "OPTIONS"])
        @app.route("/<path:path>", methods=["GET", "POST", "OPTIONS"])
        def _fallback(path):  # noqa: ARG001
            return jsonify({
                "error": {
                    "type": "boot_failure",
                    "status": 500,
                    "message": "GoatAI failed to initialize on the server.",
                    "detail": _err_text,
                }
            }), 500
    except Exception:
        # Flask itself isn't available — fall back to a raw WSGI callable so
        # the runtime at least sees a valid app object.
        def app(environ, start_response):  # type: ignore[no-redef]
            body = (
                b'{"error":{"type":"boot_failure","status":500,'
                b'"message":"GoatAI failed to initialize on the server."}}'
            )
            start_response("500 Internal Server Error", [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(body))),
                ("Cache-Control", "no-store"),
            ])
            return [body]

# Aliases for compatibility with various Vercel runtime versions.
application = app
handler = app
