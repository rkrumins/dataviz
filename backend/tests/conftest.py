"""
Test configuration: add the backend root to sys.path so that
'backend' is importable without a pyproject.toml install.
"""
import sys
import os

# Add the workspace root (parent of 'backend') to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
