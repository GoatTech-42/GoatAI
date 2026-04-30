# Vercel serverless entrypoint — imports the Flask app from app.py (one level up).
# Vercel's @vercel/python runtime discovers the WSGI app via a top-level
# `app`, `application`, or `handler` variable in this file. We therefore
# import `app` unconditionally so static analysis can find it.

import os
import sys

# Make the repo root importable so `from app import app` works even when the
# working directory is the `api/` sub-folder.
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from app import app  # noqa: E402  — top-level Flask WSGI app discovered by Vercel

# Aliases for compatibility with various Vercel runtime versions.
application = app
handler = app
